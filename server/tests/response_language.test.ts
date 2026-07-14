/**
 * response_language 单测:回复语言解析(开源中译英过渡的 keystone)。
 * Invariants: the user's observed/explicit language wins; no channel is assumed to imply a language
 * (WeChat is international — the pin was removed 2026-07-14); unknown → mirror the user; the directive
 * names the target language.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  channelOf,
  localeToLanguage,
  resolveResponseLanguage,
  buildLanguageDirective,
  observeUserLanguage,
  resolvePhraseLang,
} from '../src/response_language.js';

test('channelOf:取 sessionId 的渠道前缀', () => {
  assert.equal(channelOf('wechat:acct123:userA'), 'wechat');
  assert.equal(channelOf('webui'), 'webui');
  assert.equal(channelOf(''), '');
  assert.equal(channelOf(null), '');
});

test('localeToLanguage:常见 locale → 语言名;未知→null', () => {
  assert.equal(localeToLanguage('zh-CN'), 'Chinese');
  assert.equal(localeToLanguage('zh'), 'Chinese');
  assert.equal(localeToLanguage('en-US'), 'English');
  assert.equal(localeToLanguage('ja'), 'Japanese');
  assert.equal(localeToLanguage('xx-unknown'), null);
  assert.equal(localeToLanguage(''), null);
  assert.equal(localeToLanguage(null), null);
});

test('resolveResponseLanguage: no channel implies a language — WeChat is not pinned to Chinese', () => {
  // Removed 2026-07-14. WeChat is international; the app someone messages from is not evidence of the
  // language they speak. With nothing observed about the user, mirror them rather than assume.
  assert.equal(resolveResponseLanguage({ channel: 'wechat:acct:user' }), "the user's own language");
});

test('resolveResponseLanguage: an explicit user locale wins', () => {
  // A WeChat user whose locale is en → answer them in English.
  assert.equal(resolveResponseLanguage({ channel: 'wechat:a:b', userLocale: 'en-US' }), 'English');
});

test('resolveResponseLanguage:未知渠道无 locale → 镜像用户语言', () => {
  const lang = resolveResponseLanguage({ channel: 'telegram:bot:user' });
  assert.match(lang, /user's own language/);
});

test('buildLanguageDirective:含目标语言 + 镜像兜底说明', () => {
  const d = buildLanguageDirective('Chinese');
  assert.match(d, /Response language/);
  assert.match(d, /Chinese/);
  assert.match(d, /For User/); // 指明作用于面向用户段
  assert.match(d, /mirror/i); // 用户换语言则镜像
});

// ── observeUserLanguage: the tier that replaced the channel pin (2026-07-14) ─────────────────────
//
// WeChat used to be pinned to Chinese. That is wrong on the facts — WeChat is international, and the app
// someone messages from is not evidence of the language they speak. The resolver always had a
// higher-priority tier for the user's own locale, but nothing wrote the fact and no caller passed it, so
// the tier was a comment and the channel pin silently decided for everyone.
test('observeUserLanguage: decides what script can prove', () => {
  assert.equal(observeUserLanguage('帮我把这个日志分析一下，看看哪里出错了'), 'Chinese');
  assert.equal(observeUserLanguage('このログを分析してください'), 'Japanese');
  assert.equal(observeUserLanguage('이 로그를 분석해 주세요'), 'Korean');
  assert.equal(observeUserLanguage('Проанализируй этот лог, пожалуйста'), 'Russian');
});

test('observeUserLanguage: refuses to guess what script CANNOT prove', () => {
  // Latin script is shared by English, French, Spanish, German. Returning "English" here would be exactly
  // the confident wrong answer this whole change exists to remove — fall through to mirroring instead,
  // which works because the model can read the user's actual words.
  assert.equal(observeUserLanguage('Please analyse this log and tell me what broke'), null);
  assert.equal(observeUserLanguage('Analyse ce journal et dis-moi ce qui a cassé'), null);
});

test('observeUserLanguage: a short ack or a pasted stack trace must not re-decide the language', () => {
  // A Chinese user replying "ok" must not be flipped to English — and neither must one who pastes an
  // English traceback. Only a decisive signal re-decides; otherwise the persisted language stands.
  assert.equal(observeUserLanguage('ok'), null);
  assert.equal(observeUserLanguage('查'), null);
  assert.equal(observeUserLanguage('https://github.com/foo/bar/blob/main/x.ts#L42'), null);
  assert.equal(observeUserLanguage('TypeError: Cannot read properties of undefined (reading "map")'), null);
  // Mixed: their own words in Chinese around a pasted English error still reads as Chinese.
  assert.equal(observeUserLanguage('这个报错是什么意思 TypeError: undefined is not a function'), 'Chinese');
});

test('resolveResponseLanguage: the user\'s observed language beats the channel, and WeChat is no longer pinned', () => {
  // An English-speaking user on WeChat (WeChat International) must not be answered in Chinese.
  assert.equal(
    resolveResponseLanguage({ channel: 'wechat:acct:user', userLocale: 'en-US' }),
    'English',
  );
  // And with no observed locale, WeChat now MIRRORS rather than assuming Chinese.
  assert.equal(resolveResponseLanguage({ channel: 'wechat:acct:user' }), "the user's own language");
  // The observed language is what survives a turn with no user message — i.e. a proactive push.
  assert.equal(resolveResponseLanguage({ channel: 'wechat:acct:user', userLocale: 'Chinese' }), 'Chinese');
});

// ── AGENT_LANGUAGE: the owner's declaration (web-ui) outranks any inference ──────────────────────
test('resolveResponseLanguage: AGENT_LANGUAGE beats the observed language', () => {
  const prev = process.env.AGENT_LANGUAGE;
  try {
    // The owner declared English in the web-ui. Even though we observed them writing Chinese, a declaration
    // beats an inference — they told us, we guessed.
    process.env.AGENT_LANGUAGE = 'en';
    assert.equal(resolveResponseLanguage({ channel: 'wechat:a:b', userLocale: 'Chinese' }), 'English');
    assert.equal(resolvePhraseLang({ userLocale: 'Chinese' }), 'en');

    process.env.AGENT_LANGUAGE = 'zh';
    assert.equal(resolveResponseLanguage({ channel: 'webui', userLocale: 'English' }), 'Chinese');
    assert.equal(resolvePhraseLang({ userLocale: 'English' }), 'zh');

    // Unset / 'auto' → fall through to the observed language, then to mirroring.
    process.env.AGENT_LANGUAGE = '';
    assert.equal(resolveResponseLanguage({ userLocale: 'Chinese' }), 'Chinese');
    assert.equal(resolveResponseLanguage({}), "the user's own language");
  } finally {
    if (prev === undefined) delete process.env.AGENT_LANGUAGE;
    else process.env.AGENT_LANGUAGE = prev;
  }
});

test('resolvePhraseLang: we ship two template languages — anything not Chinese renders English', () => {
  const prev = process.env.AGENT_LANGUAGE;
  try {
    process.env.AGENT_LANGUAGE = '';
    // An observed Japanese user gets English cards today. That is a real ceiling, not full i18n — templates
    // are code strings, and we only wrote two.
    assert.equal(resolvePhraseLang({ userLocale: 'Japanese' }), 'en');
    assert.equal(resolvePhraseLang({ userLocale: 'Chinese' }), 'zh');
  } finally {
    if (prev === undefined) delete process.env.AGENT_LANGUAGE;
    else process.env.AGENT_LANGUAGE = prev;
  }
});
