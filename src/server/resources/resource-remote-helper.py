import base64
import hashlib
import json
import os
import signal
import socket
import subprocess
import sys
import time


def host_identity():
    with open('/etc/machine-id') as source:
        machine = source.read().strip()
    return hashlib.sha256((socket.gethostname() + '/linux/' + machine).encode()).hexdigest()


def identity(pid):
    try:
        with open('/proc/%d/stat' % pid) as source:
            stat = source.read()
        tail = stat[stat.rfind(')') + 1:].split()
        if tail[0] == 'Z':
            return None
        with open('/proc/sys/kernel/random/boot_id') as source:
            boot = source.read().strip()
        return {'pid': pid, 'startedAt': tail[19], 'bootId': boot}
    except FileNotFoundError:
        return None


def save(root, state):
    temporary = os.path.join(root, '.state.tmp')
    with open(temporary, 'w') as target:
        json.dump(state, target)
    os.replace(temporary, os.path.join(root, '.state.json'))


def report(value):
    print(json.dumps(value), flush=True)


payload = json.load(sys.stdin)
root = payload['workspace']
mode = payload['mode']
if mode == 'launch':
    if host_identity() != payload['node_identity']:
        raise RuntimeError('identity_changed')
    os.makedirs(root, mode=0o700, exist_ok=False)
    payload['mode'] = 'supervise'
    supervisor = subprocess.Popen(['python3', '-c', payload.pop('helper')], stdin=subprocess.PIPE,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    supervisor.stdin.write(json.dumps(payload).encode())
    supervisor.stdin.close()
    for attempt in range(100):
        try:
            with open(os.path.join(root, '.state.json')) as source:
                state = json.load(source)
            if state['status'] != 'preparing':
                report(state)
                break
        except FileNotFoundError:
            pass
        time.sleep(0.1)
    else:
        raise RuntimeError('remote_launch_unverifiable')
elif mode == 'supervise':
    state = {'status': 'preparing', 'identity': identity(os.getpid()), 'host_identity': host_identity()}
    save(root, state)
    child = None

    def stop(signum, frame):
        if child and child.poll() is None:
            child.terminate()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    with open(os.path.join(root, '.stdout'), 'wb') as out, open(os.path.join(root, '.stderr'), 'wb') as err:
        try:
            bundle = os.path.join(root, '.input.bundle')
            with open(bundle, 'wb') as target:
                target.write(base64.b64decode(payload.pop('bundle')))
            workspace = os.path.join(root, 'repo')
            subprocess.run(['git', 'clone', '--', bundle, workspace], check=True, stdout=out, stderr=err, timeout=60)
            subprocess.run(['git', '-C', workspace, 'checkout', '--detach', payload['commit']], check=True, stdout=out, stderr=err, timeout=30)
            os.remove(bundle)
            env = dict(os.environ)
            for key in ['SESSION_SECRET', 'AUTH_PASSWORD', 'TUNNEL_TOKEN']:
                env.pop(key, None)
            env.update(payload['environment'])
            if payload.get('opencode_config'):
                guard = os.path.join(root, '.shell-guard.mjs')
                with open(guard, 'w') as target:
                    target.write(payload.pop('opencode_guard'))
                config = payload.pop('opencode_config')
                config['plugin'] = ['file://' + guard]
                env['OPENCODE_CONFIG_CONTENT'] = json.dumps(config)
            child = subprocess.Popen(payload['argv'], cwd=workspace, env=env, stdin=subprocess.PIPE, stdout=out, stderr=err)
            state['status'] = 'running'
            save(root, state)
            child.communicate(payload.pop('stdin').encode())
            code = child.returncode
        except Exception as error:
            err.write(('Remote execution failed: ' + type(error).__name__ + '\n').encode())
            code = 1
        state.update(status='exited', exit_code=code)
        save(root, state)
elif mode in ['probe', 'stop']:
    if host_identity() != payload['node_identity']:
        report({'verdict': 'unverifiable', 'reason': 'identity_changed'})
        sys.exit(0)
    try:
        with open(os.path.join(root, '.state.json')) as source:
            state = json.load(source)
    except FileNotFoundError:
        report({'verdict': 'unverifiable', 'reason': 'state_missing'})
        sys.exit(0)
    expected = payload.get('identity')
    live = identity(state['identity']['pid'])
    if expected and expected != state['identity']:
        verdict = 'mismatch'
    elif state['host_identity'] != payload['node_identity']:
        verdict = 'unverifiable'
    elif state['status'] == 'exited' or live is None:
        verdict = 'exited'
    elif live != state['identity']:
        verdict = 'mismatch'
    else:
        verdict = 'match'
    if mode == 'stop' and verdict == 'match':
        os.killpg(live['pid'], signal.SIGKILL if payload.get('force') else signal.SIGTERM)
        report({'verdict': 'signalled'})
    else:
        result = {'verdict': verdict, 'state': state}
        if mode == 'probe':
            for stream in ['stdout', 'stderr']:
                offset = max(0, int(payload.get(stream + '_offset', 0)))
                try:
                    with open(os.path.join(root, '.' + stream), 'rb') as source:
                        source.seek(offset)
                        content = source.read(32768)
                        result[stream + '_offset'] = source.tell()
                        result[stream] = base64.b64encode(content).decode()
                        result[stream + '_more'] = bool(source.read(1))
                except FileNotFoundError:
                    result[stream] = ''
                    result[stream + '_offset'] = offset
        report(result)
