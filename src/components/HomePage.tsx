import Icon from "./Icon";

const modules = [
  {
    title: "主图",
    label: "商品主图生成",
    desc: "面向商城首屏、搜索结果和货架卡片，生成干净、有销售冲击力的商品主图。",
    detail: "主图模块聚焦商品第一视觉，适合商城列表、商品首图、广告封面和活动入口。系统会围绕商品主体、背景质感、陈列构图和平台合规感生成更适合成交场景的主图。",
    benefits: ["突出商品主体", "适配商城货架", "减少设计返工"],
    before: "手动找背景、修主体、调构图，单张主图也要反复改版。",
    after: "输入商品资料和参考图，快速获得统一风格的商业主图方案。",
    icon: "image" as const,
    visual: "main" as const,
    cta: "进入主图模块",
    status: "规划中",
  },
  {
    title: "详情图",
    label: "商品详情图生成",
    desc: "基于产品资料、卖点和参考图，批量生成商品详情页图文内容。",
    detail: "详情图模块把产品名称、核心卖点、功效说明和参考图组合成多张详情页内容，适合电商商品页、落地页和私域转化页。文案和图片可以逐张调整，支持重新生成当前图。",
    benefits: ["批量产出详情页", "图文结构更完整", "支持逐张重抽"],
    before: "设计、文案、修图分散协作，详情页从策划到出图周期长。",
    after: "一套产品资料生成多张详情图，文案、图片和历史记录集中管理。",
    icon: "spark" as const,
    href: "/image/",
    visual: "detail" as const,
    cta: "生成商品详情图",
    status: "已开放",
  },
  {
    title: "抠图",
    label: "白底商品图",
    desc: "上传商品图片并涂抹主体，抠出商品白底图，同时补全被遮挡的商品部分。",
    detail: "抠图模块用于把原始商品照片处理成干净的白底图。用户只需要涂抹商品区域，系统会识别商品主体，并尽量补全被遮挡或缺失的商品部分。",
    benefits: ["白底图更干净", "涂抹式选择主体", "保留抠图历史"],
    before: "传统抠图依赖手工路径和边缘修补，遇到遮挡商品需要额外精修。",
    after: "上传、涂抹、生成，快速得到可用于商城和素材库的白底商品图。",
    icon: "cutout" as const,
    href: "/cutout/",
    visual: "cutout" as const,
    cta: "制作白底商品图",
    status: "已开放",
  },
  {
    title: "多视角",
    label: "商城多角度展示",
    desc: "围绕同一商品生成正面、侧面、细节、场景等多视角展示素材。",
    detail: "多视角模块面向商城商品展示，围绕同一商品生成多个角度的展示图，帮助买家理解商品外观、结构、尺寸和细节。",
    benefits: ["同款商品多角度", "提升浏览信任感", "减少补拍成本"],
    before: "需要补拍多个角度，拍摄、打光和后期都要重新安排。",
    after: "基于商品参考图生成一组统一风格的商城多视角素材。",
    icon: "queue" as const,
    visual: "angles" as const,
    cta: "进入多视角模块",
    status: "规划中",
  },
  {
    title: "分层",
    label: "可编辑 PSD 分层",
    desc: "把图片拆成商品、背景、文案和装饰层，输出可继续编辑的 PSD 工作文件。",
    detail: "分层模块用于把已经生成或上传的图片拆成可操作素材层，目标是输出可继续编辑的 PSD 文件，让设计师可以替换背景、调整商品、修改文字和二次排版。",
    benefits: ["素材可二次编辑", "图层结构清晰", "适合设计交付"],
    before: "成图不可编辑，后续改字、换背景、移商品都要重新制作。",
    after: "把图片拆成商品、背景、文案和装饰层，沉淀为可编辑设计资产。",
    icon: "text" as const,
    visual: "layers" as const,
    cta: "进入分层模块",
    status: "规划中",
  },
  {
    title: "视频",
    label: "商品介绍视频",
    desc: "生成适合商品详情页、广告投放和短视频渠道的商品介绍视频。",
    detail: "视频模块用于生成商品介绍视频，适合商品详情页、广告投放、短视频平台和直播间素材。未来会围绕商品图、卖点脚本、镜头节奏和字幕包装生成完整视频。",
    benefits: ["商品卖点动态表达", "适合多渠道投放", "降低视频制作门槛"],
    before: "拍摄、剪辑、字幕和包装成本高，小批量商品难以快速覆盖。",
    after: "用商品资料和图片生成介绍视频，提高商品内容生产效率。",
    icon: "video" as const,
    visual: "video" as const,
    cta: "进入视频模块",
    status: "规划中",
  },
];

const workflow = ["上传商品资料", "选择创作模块", "生成商业素材", "保存历史并迭代"];

export default function HomePage() {
  return (
    <main className="app-shell home-shell">
      <header className="studio-topbar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="brand" />
          </span>
          <div>
            <h1>EcomImgGen</h1>
            <p className="tagline">Image Studio</p>
          </div>
        </div>

        <nav className="creative-tabs" aria-label="创作类型">
          <a href="/" className="creative-tab is-active" aria-current="page">
            <Icon name="brand" />
            <span>首页</span>
          </a>
          <button type="button" className="creative-tab" disabled>
            <Icon name="image" />
            <span>主图</span>
          </button>
          <a href="/image/" className="creative-tab">
            <Icon name="spark" />
            <span>详情图</span>
          </a>
          <a href="/cutout/" className="creative-tab">
            <Icon name="cutout" />
            <span>抠图</span>
          </a>
          <button type="button" className="creative-tab" disabled>
            <Icon name="queue" />
            <span>多视角</span>
          </button>
          <button type="button" className="creative-tab" disabled>
            <Icon name="text" />
            <span>分层</span>
          </button>
          <button type="button" className="creative-tab" disabled>
            <Icon name="video" />
            <span>视频</span>
          </button>
        </nav>

        <div className="top-actions home-top-actions">
          <a className="btn-primary home-start-link" href="/image/">
            开始创作
          </a>
        </div>
      </header>

      <section className="home-hero home-hero-premium">
        <div className="home-hero-copy">
          <span className="home-kicker">AI Commerce Creative Suite</span>
          <h2>一站式 AI 电商视觉资产生成平台。</h2>
          <p>
            EcomImgGen 为商品运营、设计和投放团队提供统一的 AI 创作工作台，覆盖商品主图、详情图、白底图、多视角图、PSD 分层和商品介绍视频，让商品素材生产从零散工具升级为连续工作流。
          </p>
          <div className="home-proof-row" aria-label="平台能力">
            <span>参考图一致性</span>
            <span>批量生成</span>
            <span>历史留存</span>
            <span>账号次数管理</span>
          </div>
        </div>

        <div className="home-showcase home-commerce-showcase" aria-label="电商素材工作台预览">
          <div className="commerce-board">
            <div className="commerce-board-head">
              <div>
                <span>Product Asset OS</span>
                <strong>商品素材生成中</strong>
              </div>
              <em>AI Studio</em>
            </div>
            <div className="commerce-board-body">
              <div className="commerce-product-frame">
                <div className="commerce-product">
                  <span className="commerce-product-cap" />
                  <span className="commerce-product-mark" />
                  <strong>SKU</strong>
                </div>
              </div>
              <div className="commerce-output-stack">
                <div className="commerce-output is-primary">
                  <span>主图</span>
                  <strong>商城首图</strong>
                </div>
                <div className="commerce-output is-detail">
                  <span>详情图</span>
                  <strong>卖点图文</strong>
                </div>
                <div className="commerce-output is-cutout">
                  <span>白底图</span>
                  <strong>商品主体</strong>
                </div>
              </div>
            </div>
            <div className="commerce-timeline">
              <span />
              <span />
              <span />
              <span />
            </div>
          </div>
          <div className="commerce-side-card is-psd">
            <span>PSD</span>
            <strong>分层可编辑</strong>
          </div>
          <div className="commerce-side-card is-video">
            <span>Video</span>
            <strong>商品介绍视频</strong>
          </div>
        </div>
      </section>

      <section className="home-detailed-modules" aria-label="模块详细介绍">
        {modules.map((item, index) => (
          <article className="home-module-detail" key={item.title}>
            <div className="module-detail-copy">
              <span className="home-kicker">{item.label}</span>
              <h2>{item.title}</h2>
              <p>{item.detail}</p>
              <div className="module-benefits">
                {item.benefits.map((benefit) => (
                  <span key={benefit}>{benefit}</span>
                ))}
              </div>
              <div className="module-compare">
                <div>
                  <strong>传统方式</strong>
                  <p>{item.before}</p>
                </div>
                <div>
                  <strong>EcomImgGen</strong>
                  <p>{item.after}</p>
                </div>
              </div>
              {item.href ? (
                <a className="btn-primary module-detail-cta" href={item.href}>
                  {item.cta}
                </a>
              ) : (
                <button className="btn-secondary module-detail-cta" type="button" disabled>
                  {item.cta}
                </button>
              )}
            </div>

            <div className={`module-visual is-${item.visual}`} aria-label={`${item.title}视觉示意`}>
              <div className="module-visual-stage">
                <div className="visual-window">
                  <div className="visual-window-head">
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>{item.title}</strong>
                  </div>
                  <div className="visual-artboard">
                    <div className="visual-product-shape">
                      <Icon name={item.icon} />
                    </div>
                    <div className="visual-lines">
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                </div>
                <div className="visual-badge">{item.status}</div>
              </div>
            </div>
          </article>
        ))}
      </section>

      <section className="home-workflow studio-panel">
        <div>
          <span className="home-kicker">Workflow</span>
          <h2>从商品资料到可复用素材库。</h2>
          <p>输入产品名称、卖点和参考图后，系统会把生成结果、文案和历史记录同步到云端，方便反复修改、重新生成和下载使用。</p>
        </div>
        <div className="workflow-steps">
          {workflow.map((item, index) => (
            <div className="workflow-step" key={item}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{item}</strong>
            </div>
          ))}
        </div>
      </section>

      <footer>
        EcomImgGen · 历史记录云端同步 · GitHub
        <a
          className="github-link"
          href="https://github.com/dming519/ecom-img-gen"
          target="_blank"
          rel="noreferrer"
          aria-label="查看 GitHub 仓库"
          title="查看 GitHub 仓库"
        >
          GH
        </a>
      </footer>
    </main>
  );
}
