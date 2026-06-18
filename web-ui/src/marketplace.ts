import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { agentHttpBase } from './config.js';
import { LangController, t } from './i18n.js';

const API = () => `${agentHttpBase()}/api/skills`;

interface MarketMeta {
  slug: string;
  name: string;
  description: string;
  version?: string;
  sourceId: string;
  sourceTag: string;
  trust: 'official' | 'community';
  nameZh?: string;
  descriptionZh?: string;
  tags?: string[];
}

interface Provenance {
  sourceId: string;
  identifier: string;
  sourceTag: string;
  trust: 'official' | 'community';
  version?: string;
  installedAt?: string;
}

interface InstalledItem {
  name: string;
  description: string;
  provenance: Provenance | null;
}

interface ScanHit { category: string; pattern: string; line: number; excerpt: string }
interface ScanReport { verdict: 'safe' | 'caution' | 'dangerous'; hits: ScanHit[] }

interface Inspected {
  meta: MarketMeta;
  content: string;
  scan: ScanReport;
  decision: 'allow' | 'ask' | 'block';
}

interface UpdateStatus { name: string; changed: boolean; latestVersion?: string }

@customElement('skills-marketplace')
export class SkillsMarketplace extends LitElement {
  constructor() { super(); new LangController(this); }

  @state() query = '';
  @state() sourceFilter: 'all' | 'git' | 'clawhub' = 'all';
  @state() results: MarketMeta[] = [];
  @state() warnings: string[] = [];
  @state() searching = false;
  @state() searched = false;
  @state() installed: InstalledItem[] = [];
  @state() installedNames = new Set<string>();
  @state() updates: Record<string, UpdateStatus> = {};
  @state() busy: Record<string, string> = {};
  @state() selected: Inspected | null = null;
  @state() inspecting = false;
  @state() notice: string | null = null;
  @state() error: string | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.refreshInstalled();
  }

  private async refreshInstalled() {
    try {
      const r = await fetch(`${API()}/installed`);
      const data = await r.json();
      const all: InstalledItem[] = (data.skills || []).map((s: InstalledItem & { provenance?: Provenance }) => ({
        name: s.name,
        description: s.description,
        provenance: s.provenance ?? null,
      }));
      this.installedNames = new Set(all.map((s) => s.name));
      // The marketplace section lists only skills installed THROUGH the marketplace (have provenance).
      this.installed = all.filter((s) => s.provenance);
    } catch { /* ignore */ }
    try {
      const r = await fetch(`${API()}/registry/updates`);
      const data = await r.json();
      const map: Record<string, UpdateStatus> = {};
      for (const u of (data.updates || []) as UpdateStatus[]) map[u.name] = u;
      this.updates = map;
    } catch { /* ignore */ }
  }

  private filtered(): MarketMeta[] {
    if (this.sourceFilter === 'all') return this.results;
    return this.results.filter((m) => m.sourceId === this.sourceFilter);
  }

  private async runSearch() {
    const q = this.query.trim();
    if (!q) return;
    this.searching = true;
    this.error = null;
    this.notice = null;
    try {
      const r = await fetch(`${API()}/registry/search?q=${encodeURIComponent(q)}&limit=15`);
      const data = await r.json();
      this.results = data.results || [];
      this.warnings = data.warnings || [];
      this.searched = true;
    } catch (e) {
      this.error = `${(e as Error).message}`;
    } finally {
      this.searching = false;
    }
  }

  private async openInspect(m: MarketMeta) {
    this.inspecting = true;
    this.selected = null;
    this.error = null;
    try {
      const r = await fetch(`${API()}/registry/inspect?sourceId=${encodeURIComponent(m.sourceId)}&id=${encodeURIComponent(m.slug)}`);
      if (!r.ok) { this.error = (await r.json()).error || 'inspect failed'; return; }
      this.selected = await r.json();
    } catch (e) {
      this.error = `${(e as Error).message}`;
    } finally {
      this.inspecting = false;
    }
  }

  private async install(m: MarketMeta, confirm = false) {
    this.busy = { ...this.busy, [m.name]: 'install' };
    this.error = null;
    this.notice = null;
    try {
      const r = await fetch(`${API()}/registry/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: m.sourceId, identifier: m.slug, confirm }),
      });
      const outcome = await r.json();
      if (outcome.status === 'installed') {
        this.notice = t(`已安装 ${outcome.name}`, `Installed ${outcome.name}`);
        this.selected = null;
        await this.refreshInstalled();
      } else if (outcome.status === 'ask') {
        await this.openInspect(m);
      } else if (outcome.status === 'blocked') {
        this.error = t(`已拦截:${outcome.name} 未通过安全门(${outcome.verdict})`, `Blocked: ${outcome.name} failed the safety gate (${outcome.verdict})`);
      } else {
        this.error = outcome.error || 'install failed';
      }
    } catch (e) {
      this.error = `${(e as Error).message}`;
    } finally {
      const b = { ...this.busy }; delete b[m.name]; this.busy = b;
    }
  }

  private async uninstall(name: string) {
    if (!confirm(t(`卸载 ${name}?`, `Uninstall ${name}?`))) return;
    this.busy = { ...this.busy, [name]: 'uninstall' };
    try {
      await fetch(`${API()}/installed/${encodeURIComponent(name)}`, { method: 'DELETE' });
      await this.refreshInstalled();
    } catch (e) {
      this.error = `${(e as Error).message}`;
    } finally {
      const b = { ...this.busy }; delete b[name]; this.busy = b;
    }
  }

  private async update(name: string) {
    this.busy = { ...this.busy, [name]: 'update' };
    this.error = null;
    this.notice = null;
    try {
      const r = await fetch(`${API()}/registry/update`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await r.json();
      const outcome = (data.updated && data.updated[0]) || null;
      if (outcome?.status === 'installed') {
        this.notice = t(`已更新 ${name}`, `Updated ${name}`);
        await this.refreshInstalled();
      } else if (outcome?.status === 'blocked') {
        this.error = t(`更新被拦截:新版本未通过安全扫描(${outcome.verdict})`, `Update blocked: the new version failed the safety scan (${outcome.verdict})`);
      } else if (outcome?.status === 'ask') {
        this.error = t(`新版本需确认(${outcome.verdict}),请在卡片详情里确认`, `New version needs confirmation (${outcome.verdict})`);
      } else {
        this.error = outcome?.error || data.error || t('更新失败', 'Update failed');
      }
    } catch (e) {
      this.error = `${(e as Error).message}`;
    } finally {
      const b = { ...this.busy }; delete b[name]; this.busy = b;
    }
  }

  private trustBadge(trust: string) {
    const cls = trust === 'official' ? 'badge official' : 'badge community';
    const label = trust === 'official' ? t('官方', 'Official') : t('社区', 'Community');
    return html`<span class=${cls}>${label}</span>`;
  }

  private verdictBadge(v: string) {
    return html`<span class="badge verdict-${v}">${v}</span>`;
  }

  private intro() {
    return html`
      <div class="intro">
        <h2>${t('技能广场', 'Skills Marketplace')}</h2>
        <p>${t(
          'Philont 的技能广场是一个「聚合客户端」:从外部来源搜索并一键安装 SKILL.md 技能,本身不托管任何平台。每次安装都会做安全扫描,可疑的社区内容会被拦截或要求确认。',
          'Philont\'s marketplace is an aggregator client: it searches and one-click-installs SKILL.md skills from external sources — it hosts no platform of its own. Every install is safety-scanned; suspicious community content is blocked or requires confirmation.',
        )}</p>
        <div class="markets">
          <div class="market">
            <div class="m-head"><b>git / URL</b><span class="badge community">${t('社区', 'Community')}</span></div>
            <div class="m-desc">${t(
              '从任意 GitHub 仓库或 raw SKILL.md 链接安装。在搜索框粘贴 "owner/repo[:path]"、GitHub blob 链接,或 raw SKILL.md 链接。',
              'Install from any GitHub repo or raw SKILL.md URL. Paste "owner/repo[:path]", a GitHub blob URL, or a raw SKILL.md URL into the search box.',
            )}</div>
          </div>
          <div class="market">
            <div class="m-head"><b>clawhub</b><span class="badge community">${t('社区', 'Community')}</span></div>
            <div class="m-desc">${t(
              'openclaw 社区技能注册表,按关键词搜索。需本机安装 clawhub CLI(npm i -g clawhub);未安装时关键词搜索为空。',
              'The openclaw community skill registry, searched by keyword. Requires the clawhub CLI (npm i -g clawhub); keyword search is empty without it.',
            )}</div>
          </div>
        </div>
      </div>`;
  }

  private installedSection() {
    if (!this.installed.length) return null;
    return html`
      <div class="section">
        <h3>${t('已安装(来自广场)', 'Installed (from marketplace)')}</h3>
        <div class="grid">
          ${this.installed.map((s) => {
            const upd = this.updates[s.name];
            const busy = this.busy[s.name];
            const p = s.provenance;
            return html`
              <div class="card">
                <div class="card-head">
                  <span class="name">${s.name}</span>
                  ${p?.version ? html`<span class="ver">v${p.version}</span>` : null}
                  ${p ? this.trustBadge(p.trust) : null}
                  ${p ? html`<span class="src">${p.sourceId}</span>` : null}
                </div>
                <div class="desc">${s.description}</div>
                ${p ? html`<div class="srctag">${p.sourceTag}</div>` : null}
                <div class="card-actions">
                  ${upd?.changed
                    ? html`<button @click=${() => this.update(s.name)} ?disabled=${!!busy}>${t('更新', 'Update')}${upd.latestVersion ? ` v${upd.latestVersion}` : ''}</button>`
                    : html`<span class="installed">✓ ${t('最新', 'Up to date')}</span>`}
                  <button class="danger" @click=${() => this.uninstall(s.name)} ?disabled=${!!busy}>${t('卸载', 'Uninstall')}</button>
                </div>
              </div>`;
          })}
        </div>
        <div class="muted">${t('其余内置/自习得技能见「记忆 → 技能」页。', 'Bundled / self-learned skills are listed under Memory → Skills.')}</div>
      </div>`;
  }

  private card(m: MarketMeta) {
    const installed = this.installedNames.has(m.name);
    const upd = this.updates[m.name];
    const busy = this.busy[m.name];
    return html`
      <div class="card" @click=${() => this.openInspect(m)}>
        <div class="card-head">
          <span class="name">${t(m.nameZh || m.name, m.name)}</span>
          ${m.version ? html`<span class="ver">v${m.version}</span>` : null}
          ${this.trustBadge(m.trust)}
          <span class="src">${m.sourceId}</span>
        </div>
        <div class="desc">${t(m.descriptionZh || m.description, m.description)}</div>
        <div class="card-actions" @click=${(e: Event) => e.stopPropagation()}>
          ${installed
            ? (upd?.changed
              ? html`<button @click=${() => this.update(m.name)} ?disabled=${!!busy}>${t('更新', 'Update')}${upd.latestVersion ? ` v${upd.latestVersion}` : ''}</button>`
              : html`<span class="installed">✓ ${t('已安装', 'Installed')}</span>`)
            : html`<button class="primary" @click=${() => this.install(m)} ?disabled=${!!busy}>${busy === 'install' ? t('安装中…', 'Installing…') : t('安装', 'Install')}</button>`}
          ${installed ? html`<button class="danger" @click=${() => this.uninstall(m.name)} ?disabled=${!!busy}>${t('卸载', 'Uninstall')}</button>` : null}
        </div>
      </div>`;
  }

  private modal() {
    if (!this.selected) return null;
    const s = this.selected;
    const needsConfirm = s.decision === 'ask';
    const blocked = s.decision === 'block';
    return html`
      <div class="overlay" @click=${() => (this.selected = null)}>
        <div class="dialog" @click=${(e: Event) => e.stopPropagation()}>
          <div class="dialog-head">
            <span class="name">${t(s.meta.nameZh || s.meta.name, s.meta.name)}</span>
            ${this.trustBadge(s.meta.trust)}
            ${this.verdictBadge(s.scan.verdict)}
            <button class="x" @click=${() => (this.selected = null)}>✕</button>
          </div>
          <div class="dialog-sub">${s.meta.sourceTag}</div>
          ${s.meta.trust === 'community'
            ? html`<div class="warn-banner">${t('社区技能,安装前请审阅内容。', 'Community skill — review the content before installing.')}</div>`
            : null}
          ${s.scan.hits.length
            ? html`<div class="scan">
                <div class="scan-title">${t('安全扫描发现', 'Safety scan findings')} (${s.scan.verdict}):</div>
                <ul>${s.scan.hits.map((h) => html`<li><b>${h.category}</b>: ${h.pattern} <span class="ln">L${h.line}</span></li>`)}</ul>
              </div>`
            : html`<div class="scan ok">${t('安全扫描:未发现可疑模式', 'Safety scan: no suspicious patterns')}</div>`}
          <pre class="skillmd">${s.content}</pre>
          <div class="dialog-actions">
            ${blocked
              ? html`<span class="blocked">${t('已被安全门拦截,无法安装', 'Blocked by the safety gate — cannot install')}</span>`
              : html`<button class="primary" @click=${() => this.install(s.meta, needsConfirm)}>
                  ${needsConfirm ? t('确认安装', 'Confirm install') : t('安装', 'Install')}
                </button>`}
            <button @click=${() => (this.selected = null)}>${t('关闭', 'Close')}</button>
          </div>
        </div>
      </div>`;
  }

  render() {
    const list = this.filtered();
    return html`
      <div class="wrap">
        ${this.intro()}

        <div class="toolbar">
          <input
            type="text"
            .value=${this.query}
            @input=${(e: Event) => (this.query = (e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') this.runSearch(); }}
            placeholder=${t('搜索技能,或粘贴 GitHub owner/repo / SKILL.md 链接', 'Search skills, or paste a GitHub owner/repo / SKILL.md URL')}
          />
          <select .value=${this.sourceFilter} @change=${(e: Event) => (this.sourceFilter = (e.target as HTMLSelectElement).value as 'all' | 'git' | 'clawhub')}>
            <option value="all">${t('全部来源', 'All sources')}</option>
            <option value="git">git / URL</option>
            <option value="clawhub">clawhub</option>
          </select>
          <button class="primary" @click=${() => this.runSearch()} ?disabled=${this.searching}>
            ${this.searching ? t('搜索中…', 'Searching…') : t('搜索', 'Search')}
          </button>
        </div>

        ${this.notice ? html`<div class="notice">${this.notice}</div>` : null}
        ${this.error ? html`<div class="err">${this.error}</div>` : null}
        ${this.warnings.length ? html`<div class="warns">⚠ ${this.warnings.join('; ')}</div>` : null}
        ${this.inspecting ? html`<div class="loading">${t('加载中…', 'Loading…')}</div>` : null}

        ${this.installedSection()}

        ${this.searched
          ? html`<div class="section">
              <h3>${t('搜索结果', 'Search results')}</h3>
              ${list.length
                ? html`<div class="grid">${list.map((m) => this.card(m))}</div>`
                : html`<div class="empty">${t('没有结果。试试粘贴一个 GitHub owner/repo 或 SKILL.md 链接。', 'No results. Try pasting a GitHub owner/repo or SKILL.md URL.')}</div>`}
            </div>`
          : html`<div class="hint">${t('输入关键词(clawhub)或粘贴 git 链接开始搜索。', 'Enter keywords (clawhub) or paste a git URL to start searching.')}</div>`}

        ${this.modal()}
      </div>`;
  }

  static styles = css`
    :host { display: block; height: 100%; overflow: auto; }
    .wrap { padding: 20px 24px; max-width: 1000px; margin: 0 auto; }
    .intro { margin-bottom: 16px; }
    .intro h2 { margin: 0 0 6px; font-size: 20px; }
    .intro p { margin: 0 0 12px; color: #555; font-size: 13px; line-height: 1.5; }
    .markets { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .market { border: 1px solid #e5e5e5; border-radius: 8px; padding: 10px 12px; background: #fafafa; }
    .m-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
    .m-desc { color: #666; font-size: 12px; line-height: 1.45; }
    .section { margin-top: 18px; }
    .section h3 { font-size: 15px; margin: 0 0 8px; }
    .muted { color: #999; font-size: 12px; margin-top: 8px; }
    .toolbar { display: flex; gap: 8px; margin-top: 16px; }
    .toolbar input { flex: 1; padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; }
    .toolbar select { padding: 8px; border: 1px solid #ccc; border-radius: 6px; }
    button { padding: 6px 12px; border: 1px solid #ccc; border-radius: 6px; background: white; cursor: pointer; font-size: 13px; }
    button:hover:not(:disabled) { background: #f5f5f5; }
    button:disabled { opacity: 0.5; cursor: default; }
    button.primary { background: #1976d2; color: white; border-color: #1976d2; }
    button.primary:hover:not(:disabled) { background: #1565c0; }
    button.danger { color: #c62828; border-color: #e0b4b4; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
    .card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px; cursor: pointer; background: white; transition: box-shadow .15s; }
    .card:hover { box-shadow: 0 2px 8px rgba(0,0,0,.08); }
    .card-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
    .name { font-weight: 600; }
    .ver { color: #888; font-size: 12px; }
    .src { color: #999; font-size: 11px; margin-left: auto; }
    .srctag { color: #aaa; font-size: 11px; margin-top: 4px; word-break: break-all; }
    .desc { color: #555; font-size: 13px; line-height: 1.4; min-height: 36px; }
    .card-actions { display: flex; gap: 6px; margin-top: 8px; }
    .installed { color: #2e7d32; font-size: 13px; align-self: center; }
    .badge { font-size: 11px; padding: 1px 6px; border-radius: 4px; }
    .badge.official { background: #e8f5e9; color: #2e7d32; }
    .badge.community { background: #fff8e1; color: #f57f17; }
    .badge.verdict-safe { background: #e8f5e9; color: #2e7d32; }
    .badge.verdict-caution { background: #fff8e1; color: #f57f17; }
    .badge.verdict-dangerous { background: #ffebee; color: #c62828; }
    .notice { background: #e8f5e9; color: #2e7d32; padding: 8px 12px; border-radius: 6px; margin-top: 12px; }
    .err { background: #ffebee; color: #c62828; padding: 8px 12px; border-radius: 6px; margin-top: 12px; }
    .warns { background: #fff8e1; color: #f57f17; padding: 8px 12px; border-radius: 6px; margin-top: 12px; font-size: 13px; }
    .empty, .hint, .loading { color: #888; padding: 24px 8px; font-size: 14px; }
    .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
    .dialog { background: white; border-radius: 10px; width: min(720px, 92vw); max-height: 86vh; overflow: auto; padding: 18px 20px; }
    .dialog-head { display: flex; align-items: center; gap: 8px; }
    .dialog-head .x { margin-left: auto; border: none; font-size: 16px; }
    .dialog-sub { color: #999; font-size: 12px; margin: 4px 0 10px; word-break: break-all; }
    .warn-banner { background: #fff8e1; color: #f57f17; padding: 8px 12px; border-radius: 6px; margin-bottom: 10px; font-size: 13px; }
    .scan { margin-bottom: 10px; font-size: 13px; }
    .scan.ok { color: #2e7d32; }
    .scan-title { color: #c62828; font-weight: 600; margin-bottom: 4px; }
    .scan ul { margin: 0; padding-left: 18px; }
    .scan .ln { color: #999; }
    .skillmd { background: #f6f8fa; border: 1px solid #eee; border-radius: 6px; padding: 12px; font-size: 12px; max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
    .dialog-actions { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
    .blocked { color: #c62828; font-size: 13px; }
  `;
}
