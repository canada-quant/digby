/** isDegenerate — e6b16c4e hardening: a final answer that repeats page filler
 *  with NO sentence punctuation (the incident's Chinese slider-CAPTCHA wall —
 *  thousands of（拖拽）"drag here" tokens around empty <div> shells) must be
 *  caught, not waved through on the `sentences.length < 4` early pass. */

// glm-loop transitively imports logger → env.ts (process.exit on missing env in
// a bare test env) and driver/router modules; mock the leaves so importing the
// pure isDegenerate helper never triggers env validation.
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('./glm-client', () => ({
  __esModule: true,
  glmChat: jest.fn(),
  stripThink: (s: string) => s,
}));
jest.mock('./router', () => ({ __esModule: true, selectBrowserDriver: jest.fn() }));

import { isDegenerate } from './glm-loop';

/** The incident's shape:（拖拽）filler repeated thousands of times, wrapped in
 *  empty div markup — no '.', '!' or '?' anywhere, so the sentence splitter
 *  yields ~1 sentence and the pre-fix guard passed it as a valid answer. */
const dragWall = (repeats: number) =>
  Array(repeats)
    .fill('<div>（拖拽）（拖拽）（拖拽）（拖拽）（拖拽）</div>')
    .join('');

describe('isDegenerate — e6b16c4e punctuation-free filler', () => {
  it('flags the（拖拽）drag-filler wall (the ticket\'s exact payload shape)', () => {
    const wall = dragWall(600); // ~8k chars, zero sentence punctuation
    expect(wall.length).toBeGreaterThan(400);
    expect(isDegenerate(wall)).toBe(true);
  });

  it('flags a smaller drag wall above the length floor', () => {
    expect(isDegenerate(dragWall(100))).toBe(true);
  });

  it('flags a pure CJK character wall (no markup wrapper)', () => {
    const wall = '拖拽'.repeat(400); // 800 CJK chars, no spaces, no punctuation
    expect(isDegenerate(wall)).toBe(true);
  });

  it('still passes a real varied report (no false positive)', () => {
    const report = [
      '打开页面后确认了首页可以正常加载，顶部的导航栏和搜索框都渲染正常，没有发现布局错乱的问题。',
      '点击登录按钮后正确跳转到登录页，表单字段显示完整，邮箱格式的行内校验功能可以正常工作。',
      '页面底部的备案信息和公司地址都能正常显示，链接指向正确的目标页面，没有发现死链的情况。',
      '移动端布局下导航栏折叠为汉堡菜单，功能可用，展开和收起的动画过渡流畅自然没有卡顿。',
      '图片在视口滚动到附近时才开始加载，懒加载策略工作正常，首屏的加载体积得到了有效控制。',
      '整体检查完成，页面的核心功能都可以正常使用，没有发现明显的功能缺陷或渲染错误的问题。',
      '另外确认了浏览器控制台没有报错，网络请求的响应时间都在正常范围内，页面资源的加载顺序也符合预期。',
      '截图对比显示新旧版本的视觉样式保持一致，字体渲染清晰，没有出现错位或者被裁切的情况发生。',
      '在弱网环境下页面也能给出合理的加载提示，不会长时间停留在空白状态让用户误以为页面已经崩溃。',
      '综合以上所有检查点的结果，这个页面可以放心交付使用，后续只需要按照常规流程进行监控即可。',
    ].join('');
    expect(report.length).toBeGreaterThan(400);
    expect(isDegenerate(report)).toBe(false);
  });

  it('still passes a LONG genuine Chinese report (reviewer round-2 magnitude: 2,900+ CJK, 的 ×100+)', () => {
    // The reviewer's blocking repro: an absolute CJK count ceiling (first-draft
    // >80) false-flagged exactly this class — a genuine 70+ sentence report
    // where 的 alone occurs 113× (share 0.040). Re-pin at that magnitude: the
    // share-based leg must keep it non-degenerate. Generator: 15 pages × 8
    // aspects = 120 DISTINCT sentences (no verbatim repeats, so the sentence
    // leg stays quiet too) ≈ 3,000 CJK chars with 的 ×200+.
    const pages = ['首页', '产品介绍页', '价格方案页', '帮助文档页', '公司博客页', '关于我们页', '联系表单页', '帮助中心页', '搜索结果页', '用户设置页', '订单列表页', '账户安全页', '通知中心页', '数据报表页', '团队成员页'];
    const aspects = [
      '顶部导航栏的渲染', '表单字段的校验', '页脚链接的指向', '移动端布局的折叠',
      '图片懒加载的触发', '控制台报错的检查', '响应时间的测量', '浏览器兼容性的表现',
    ];
    const results = [
      '结果完全正常，没有发现任何问题。',
      '结果符合预期，细节处理得很好。',
      '结果令人满意，功能可以放心使用。',
      '结果没有异常，体验流畅自然。',
      '结果通过复查，数据保存正确。',
      '结果稳定可靠，多次刷新后一致。',
      '结果在合理范围内，无需调整。',
      '结果好于预期，性能表现优秀。',
    ];
    const sentences: string[] = [];
    pages.forEach((page, pi) => {
      aspects.forEach((aspect, ai) => {
        // 的 occurs in aspect + often in result → ~2-3× per sentence.
        sentences.push(`对${page}的${aspect}${results[(pi + ai) % results.length]}`);
      });
    });
    expect(new Set(sentences).size).toBe(sentences.length); // all distinct
    const full = sentences.join('');
    const cjkChars = (full.match(/[\u4e00-\u9fff]/g) || []).length;
    expect(cjkChars).toBeGreaterThanOrEqual(2900); // the reviewer's crossover magnitude
    const deCount = (full.match(/的/g) || []).length;
    expect(deCount).toBeGreaterThanOrEqual(100); // 的 ×100+ — the count that breached >80
    expect(isDegenerate(full)).toBe(false);
  });

  it('still passes a terse varied English report', () => {
    const report = [
      'checked the homepage heading renders correctly on first paint',
      'the nav bar links all resolve to live pages without redirects',
      'the download button starts a real file transfer and reports progress',
      'the contact form validates email format inline before submission',
      'the footer links match the sitemap entries one for one across pages',
      'no console errors appeared during the whole run across all routes',
      'the mobile layout collapses the nav into a working hamburger menu',
      'images lazy-load as the viewport scrolls down through the gallery',
      'the search box returns matching results for the obvious queries tried',
      'session state survives a full page reload with no visible data loss',
    ].join('\n');
    expect(report.length).toBeGreaterThan(400);
    expect(isDegenerate(report)).toBe(false);
  });

  it('still flags the classic repeated-sentence monologue (no regression)', () => {
    const loop = Array(12).fill('Let me check the next thing on the page carefully now.').join(' ');
    expect(isDegenerate(loop)).toBe(true);
  });

  it('still passes short answers (never degenerate under 400 chars)', () => {
    expect(isDegenerate('The page loads and the login button works.')).toBe(false);
    expect(isDegenerate('')).toBe(false);
  });
});
