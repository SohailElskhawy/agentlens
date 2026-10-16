import test from 'node:test';
import assert from 'node:assert/strict';
import { sendDesktopNotification } from '../src/report-scheduler.ts';

test('sendDesktopNotification: dispatches osascript on macOS (darwin)', () => {
  let calledCmd = '';
  let calledArgs: string[] = [];
  const fakeSpawn: any = (cmd: string, args: string[]) => {
    calledCmd = cmd;
    calledArgs = args;
    return { on: () => {}, unref: () => {} };
  };

  const ok = sendDesktopNotification('agentlens Weekly', 'Report ready', 'darwin', fakeSpawn);
  assert.equal(ok, true);
  assert.equal(calledCmd, 'osascript');
  assert.equal(calledArgs[0], '-e');
  assert.ok(calledArgs[1].includes('display notification'));
  assert.ok(calledArgs[1].includes('Report ready'));
  assert.ok(calledArgs[1].includes('agentlens Weekly'));
});

test('sendDesktopNotification: dispatches powershell toast on Windows (win32)', () => {
  let calledCmd = '';
  let calledArgs: string[] = [];
  const fakeSpawn: any = (cmd: string, args: string[]) => {
    calledCmd = cmd;
    calledArgs = args;
    return { on: () => {}, unref: () => {} };
  };

  const ok = sendDesktopNotification('agentlens Weekly', 'Report ready', 'win32', fakeSpawn);
  assert.equal(ok, true);
  assert.equal(calledCmd, 'powershell');
  assert.ok(calledArgs.includes('-NoProfile'));
  assert.ok(calledArgs.includes('-ExecutionPolicy'));
  assert.ok(calledArgs.includes('Bypass'));
  assert.ok(calledArgs.includes('-Command'));
  assert.ok(calledArgs.some((arg) => arg.includes('System.Windows.Forms.NotifyIcon')));
  assert.ok(calledArgs.some((arg) => arg.includes('param($title, $body)')));
  assert.equal(calledArgs[calledArgs.length - 2], 'agentlens Weekly');
  assert.equal(calledArgs[calledArgs.length - 1], 'Report ready');
});

test('sendDesktopNotification: dispatches notify-send on Linux', () => {
  let calledCmd = '';
  let calledArgs: string[] = [];
  const fakeSpawn: any = (cmd: string, args: string[]) => {
    calledCmd = cmd;
    calledArgs = args;
    return { on: () => {}, unref: () => {} };
  };

  const ok = sendDesktopNotification('agentlens Weekly', 'Report ready', 'linux', fakeSpawn);
  assert.equal(ok, true);
  assert.equal(calledCmd, 'notify-send');
  assert.deepEqual(calledArgs, ['agentlens Weekly', 'Report ready']);
});

test('sendDesktopNotification: safely escapes quotes and special chars (Review Focus 3)', () => {
  let darwinScript = '';
  const fakeSpawnDarwin: any = (_cmd: string, args: string[]) => {
    darwinScript = args[1];
    return { on: () => {}, unref: () => {} };
  };
  sendDesktopNotification('Title with "quotes" and \'apostrophes\'', 'Line 1\nLine "2"', 'darwin', fakeSpawnDarwin);
  assert.ok(darwinScript.startsWith('display notification '));
  assert.doesNotThrow(() => JSON.parse(darwinScript.split('display notification ')[1].split(' with title ')[0]));

  let winArgs: string[] = [];
  const fakeSpawnWin: any = (_cmd: string, args: string[]) => {
    winArgs = args;
    return { on: () => {}, unref: () => {} };
  };
  sendDesktopNotification('Title "test"', 'Body "test"', 'win32', fakeSpawnWin);
  const cmdIdx = winArgs.indexOf('-Command');
  assert.ok(winArgs[cmdIdx + 1].includes('param($title, $body)'));
  assert.ok(!winArgs[cmdIdx + 1].includes('Title "test"'));
  assert.equal(winArgs[cmdIdx + 2], 'Title "test"');
  assert.equal(winArgs[cmdIdx + 3], 'Body "test"');
});

test('sendDesktopNotification: returns false gracefully when spawn throws (Review Focus 5)', () => {
  const throwingSpawn: any = () => {
    throw new Error('EACCES spawn error');
  };
  const ok = sendDesktopNotification('Title', 'Body', 'darwin', throwingSpawn);
  assert.equal(ok, false);
});

test('sendDesktopNotification: registers error event handler to prevent uncaught exceptions (Review Focus 5)', () => {
  let errorRegistered = false;
  const fakeSpawn: any = () => {
    return {
      on: (event: string) => {
        if (event === 'error') {
          errorRegistered = true;
        }
      },
      unref: () => {},
    };
  };
  const ok = sendDesktopNotification('Title', 'Body', 'linux', fakeSpawn);
  assert.equal(ok, true);
  assert.equal(errorRegistered, true);
});

test('sendDesktopNotification: default arguments use ambient platform and spawn', () => {
  const ok = sendDesktopNotification('Test Title', 'Test Body');
  assert.equal(typeof ok, 'boolean');
});

