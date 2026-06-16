import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeShellOutput,
  detectReplacementChar,
  detectShellKind,
  prefixCommandWithUtf8,
  sanitizeReplacementChar,
} from '../src/utils/encoding.js';

describe('decodeShellOutput (UTF-8 → GBK auto-detect)', () => {
  it('decodes GBK-encoded bytes (Windows piped cmd output)', () => {
    // "驱动器 E" in GBK/cp936 — what `dir` emits on zh-CN Windows even with chcp 65001
    const gbk = Buffer.from([0xc7, 0xfd, 0xb6, 0xaf, 0xc6, 0xf7, 0x20, 0x45]);
    assert.equal(decodeShellOutput(gbk), '驱动器 E');
  });
  it('decodes valid UTF-8 bytes unchanged', () => {
    assert.equal(decodeShellOutput(Buffer.from('结论：ES 撞墙', 'utf8')), '结论：ES 撞墙');
  });
  it('ASCII (gp.exe banner) decodes identically', () => {
    assert.equal(decodeShellOutput(Buffer.from('=== ANALYSIS ===', 'utf8')), '=== ANALYSIS ===');
  });
  it('null/undefined/string pass through safely', () => {
    assert.equal(decodeShellOutput(null), '');
    assert.equal(decodeShellOutput(undefined), '');
    assert.equal(decodeShellOutput('already decoded'), 'already decoded');
  });
});

// process.platform 是只读 getter，但可以用 Object.defineProperty 临时覆盖
// 来模拟 Windows 行为而不实际跨平台跑。
function withPlatform<T>(target: NodeJS.Platform, fn: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    value: target,
    configurable: true,
    writable: false,
  });
  try {
    return fn();
  } finally {
    if (desc) Object.defineProperty(process, 'platform', desc);
  }
}

describe('encoding.detectShellKind', () => {
  it('identifies powershell prefix', () => {
    assert.equal(detectShellKind('powershell -Command Get-Process'), 'pwsh');
    assert.equal(detectShellKind('pwsh -c whoami'), 'pwsh');
  });

  it('identifies cmd prefix', () => {
    assert.equal(detectShellKind('cmd /c dir'), 'cmd');
    assert.equal(detectShellKind('cmd.exe /c echo hi'), 'cmd');
  });

  it('falls back to platform default for plain commands', () => {
    const out = detectShellKind('ls -la');
    // 在当前机器（Linux）上应当返回 bash；在 Windows runner 上会返回 cmd
    assert.ok(out === 'bash' || out === 'cmd');
  });
});

describe('encoding.prefixCommandWithUtf8', () => {
  describe('on non-Windows', () => {
    before(() => {
      // 当前环境本来就是 Linux，但显式确认一遍语义
      assert.notEqual(process.platform, 'win32');
    });

    it('passes through command unchanged', () => {
      assert.equal(prefixCommandWithUtf8('ls -la'), 'ls -la');
      assert.equal(prefixCommandWithUtf8('echo hi', 'cmd'), 'echo hi');
      assert.equal(prefixCommandWithUtf8('echo hi', 'pwsh'), 'echo hi');
    });
  });

  describe('on Windows', () => {
    it('wraps cmd commands with chcp 65001', () => {
      withPlatform('win32', () => {
        const out = prefixCommandWithUtf8('dir C:\\Users');
        assert.equal(out, 'chcp 65001 >nul && dir C:\\Users');
      });
    });

    it('wraps powershell commands with OutputEncoding setter', () => {
      withPlatform('win32', () => {
        const out = prefixCommandWithUtf8('powershell -c Get-Process');
        assert.match(out, /\[Console\]::OutputEncoding\s*=/);
        assert.match(out, /\[Console\]::InputEncoding\s*=/);
        assert.ok(out.endsWith('powershell -c Get-Process'));
      });
    });

    it('does not double-inject when command already has chcp', () => {
      withPlatform('win32', () => {
        const cmd = 'chcp 65001 && dir';
        assert.equal(prefixCommandWithUtf8(cmd), cmd);
      });
    });

    it('does not inject when command already configures OutputEncoding', () => {
      withPlatform('win32', () => {
        const cmd =
          '[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Get-Date';
        assert.equal(prefixCommandWithUtf8(cmd), cmd);
      });
    });

    it('leaves bash/sh commands alone (Git Bash / WSL already UTF-8)', () => {
      withPlatform('win32', () => {
        // bash 命令在 Windows 上由 Git Bash 或 WSL 执行——它们默认 UTF-8
        // 我们走启发式判断（命令第一 token），但平台默认是 cmd。
        // 这里测试显式传 shell 参数的路径。
        const out = prefixCommandWithUtf8('ls -la', 'bash');
        assert.equal(out, 'ls -la');
      });
    });
  });
});

describe('encoding.detectReplacementChar', () => {
  it('returns true when text contains U+FFFD', () => {
    assert.equal(detectReplacementChar('hello � world'), true);
    assert.equal(detectReplacementChar('������ C'), true);
  });

  it('returns false for clean text', () => {
    assert.equal(detectReplacementChar('hello world'), false);
    assert.equal(detectReplacementChar('中文也行'), false);
    assert.equal(detectReplacementChar(''), false);
  });
});

describe('encoding.sanitizeReplacementChar', () => {
  it('replaces U+FFFD with placeholder', () => {
    assert.equal(sanitizeReplacementChar('a�b'), 'a?b');
    assert.equal(sanitizeReplacementChar('��'), '??');
  });

  it('accepts custom placeholder', () => {
    assert.equal(sanitizeReplacementChar('a�b', '[?]'), 'a[?]b');
  });

  it('leaves clean text unchanged', () => {
    assert.equal(sanitizeReplacementChar('hello'), 'hello');
  });
});
