<script setup lang="ts">
import Icon from "./Icon.vue"

const modules = [
  {
    title: "主图",
    label: "商品主图生成",
    desc: "面向商城首屏、搜索结果和货架卡片，生成干净、有销售冲击力的商品主图。",
    detail: "主图模式聚焦商品第一视觉，固定生成 5 张 1:1 商城主图，适合商城列表、商品首图、广告封面和活动入口。系统会围绕商品主体、背景质感、陈列构图和平台合规感生成更适合成交场景的主图。",
    benefits: ["突出商品主体", "适配商城货架", "减少设计返工"],
    before: "手动找背景、修主体、调构图，单张主图也要反复改版。",
    after: "输入商品资料和参考图，快速获得统一风格的 5 张主图方案。",
    icon: "image" as const,
    href: "/image/",
    visual: "main",
    cta: "进入图包工作台",
    status: "已开放",
  },
  {
    title: "详情图",
    label: "商品图包生成",
    desc: "基于商品资料、卖点和参考图，批量生成商品详情页图文内容。",
    detail: "详情图模式把商品名称、核心卖点、功效说明和参考图组合成固定 8 张 3:4 详情页内容，适合电商商品页、落地页和私域转化页。文案和图片可以逐张调整，支持重新生成当前图。",
    benefits: ["批量产出详情页", "图文结构更完整", "支持逐张重抽"],
    before: "设计、文案、修图分散协作，详情页从策划到出图周期长。",
    after: "一套商品资料生成 8 张详情图，文案、图片和历史记录集中管理。",
    icon: "spark" as const,
    href: "/image/",
    visual: "detail",
    cta: "进入图包工作台",
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
    visual: "cutout",
    cta: "制作白底商品图",
    status: "已开放",
  },
  {
    title: "改图",
    label: "局部商品改图",
    desc: "上传商品图片，涂抹需要修改的区域，并输入修改内容生成局部改图结果。",
    detail: "改图模块用于对商品图进行局部修改。用户上传原图后涂抹要改的位置，输入颜色、材质、瑕疵修复、局部结构或图案调整等需求，系统会尽量只修改涂抹区域并保留未选中部分。",
    benefits: ["局部可控修改", "保持商品一致", "保留改图历史"],
    before: "轻微改色、去瑕疵或局部换材质也要重新修图，容易影响整张图。",
    after: "涂抹区域并输入修改内容，快速生成局部调整后的商品图。",
    icon: "brush" as const,
    href: "/edit/",
    visual: "edit",
    cta: "进入改图模块",
    status: "已开放",
  },
  {
    title: "拆图",
    label: "PNG 图层拆分",
    desc: "按图片内容动态拆出可编辑图层，打包下载白底 PNG 图层。",
    detail: "拆图模块用于把已经生成或上传的图片拆成可操作素材层，系统会先识别画面中真实存在的商品、模特、文字、背景、道具和光影关系，再输出白底 PNG 图层包和图层清单。",
    benefits: ["白底 PNG 图层", "图层结构清晰", "ZIP 打包下载"],
    before: "成图不可编辑，后续改字、换背景、移商品都要重新制作。",
    after: "把图片按实际画面结构拆成可编辑图层，沉淀为设计资产。",
    icon: "text" as const,
    href: "/layer/",
    visual: "layers",
    cta: "进入拆图模块",
    status: "已开放",
  },
  {
    title: "多视角",
    label: "商城多角度展示",
    desc: "围绕同一商品生成正面、侧面、背面等纯白底多视角商品图。",
    detail: "多视角模块面向商城商品展示，基于上传参考图自动分配标准角度，生成纯白背景、无营销文案、只展示商品本体的多角度商品图。",
    benefits: ["同款商品多角度", "提升浏览信任感", "减少补拍成本"],
    before: "需要补拍多个角度，拍摄、打光和后期都要重新安排。",
    after: "上传参考图并选择视角，系统自动产出统一白底的多视角商品素材。",
    icon: "queue" as const,
    href: "/multi-view/",
    visual: "angles",
    cta: "进入多视角模块",
    status: "已开放",
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
    visual: "video",
    cta: "进入视频模块",
    status: "规划中",
  },
]

const workflow = ["上传商品资料", "选择创作模块", "生成商业素材", "保存历史并迭代"]
</script>

<template>
  <main class="app-shell home-shell">
    <header class="studio-topbar">
      <div class="brand-block">
        <span class="brand-mark" aria-hidden="true">
          <Icon name="brand" />
        </span>
        <div>
          <h1>EcomImgGen</h1>
          <p class="tagline">Image Studio</p>
        </div>
      </div>

      <nav class="creative-tabs" aria-label="创作类型">
        <NuxtLink to="/" class="creative-tab is-active" aria-current="page">
          <Icon name="brand" />
          <span>首页</span>
        </NuxtLink>
        <NuxtLink to="/image/" class="creative-tab">
          <Icon name="spark" />
          <span>生图</span>
        </NuxtLink>
        <NuxtLink to="/cutout/" class="creative-tab">
          <Icon name="cutout" />
          <span>抠图</span>
        </NuxtLink>
        <NuxtLink to="/edit/" class="creative-tab">
          <Icon name="brush" />
          <span>改图</span>
        </NuxtLink>
        <NuxtLink to="/layer/" class="creative-tab">
          <Icon name="text" />
          <span>拆图</span>
        </NuxtLink>
        <NuxtLink to="/multi-view/" class="creative-tab">
          <Icon name="queue" />
          <span>多视角</span>
        </NuxtLink>
      </nav>

      <div class="top-actions home-top-actions">
        <NuxtLink class="btn-primary home-start-link" to="/image/">
          开始创作
        </NuxtLink>
      </div>
    </header>

    <section class="home-hero home-hero-premium">
      <div class="home-hero-copy">
        <span class="home-kicker">AI Commerce Creative Suite</span>
        <h2>一站式 AI 电商视觉资产生成平台。</h2>
        <p>
          EcomImgGen 为商品运营、设计和投放团队提供统一的 AI 创作工作台，覆盖商品主图、详情图、白底图、多视角图、PNG 拆图和商品介绍视频，让商品素材生产从零散工具升级为连续工作流。
        </p>
        <div class="home-proof-row" aria-label="平台能力">
          <span>参考图一致性</span>
          <span>批量生成</span>
          <span>历史留存</span>
          <span>账号次数管理</span>
        </div>
      </div>

      <div class="home-showcase home-commerce-showcase" aria-label="电商素材工作台预览">
        <div class="commerce-board">
          <div class="commerce-board-head">
            <div>
              <span>Product Asset OS</span>
              <strong>商品素材生成中</strong>
            </div>
            <em>AI Studio</em>
          </div>
          <div class="commerce-board-body">
            <div class="commerce-product-frame">
              <div class="commerce-product">
                <span class="commerce-product-cap" />
                <span class="commerce-product-mark" />
                <strong>SKU</strong>
              </div>
            </div>
            <div class="commerce-output-stack">
              <div class="commerce-output is-primary">
                <span>主图</span>
                <strong>商城首图</strong>
              </div>
              <div class="commerce-output is-detail">
                <span>详情图</span>
                <strong>卖点图文</strong>
              </div>
              <div class="commerce-output is-cutout">
                <span>白底图</span>
                <strong>商品主体</strong>
              </div>
            </div>
          </div>
          <div class="commerce-timeline">
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
        <div class="commerce-side-card is-psd">
          <span>PNG</span>
          <strong>拆图可编辑</strong>
        </div>
        <div class="commerce-side-card is-video">
          <span>Video</span>
          <strong>商品介绍视频</strong>
        </div>
      </div>
    </section>

    <section class="home-detailed-modules" aria-label="模块详细介绍">
      <article
        v-for="(item, index) in modules"
        :key="item.title"
        class="home-module-detail"
      >
        <div class="module-detail-copy">
          <span class="home-kicker">{{ item.label }}</span>
          <h2>{{ item.title }}</h2>
          <p>{{ item.detail }}</p>
          <div class="module-benefits">
            <span v-for="benefit in item.benefits" :key="benefit">{{ benefit }}</span>
          </div>
          <div class="module-compare">
            <div>
              <strong>传统方式</strong>
              <p>{{ item.before }}</p>
            </div>
            <div>
              <strong>EcomImgGen</strong>
              <p>{{ item.after }}</p>
            </div>
          </div>
          <NuxtLink v-if="item.href" class="btn-primary module-detail-cta" :to="item.href">
            {{ item.cta }}
          </NuxtLink>
          <button v-else class="btn-secondary module-detail-cta" type="button" disabled title="该模块规划中，敬请期待！">
            {{ item.cta }} (规划中)
          </button>
        </div>

        <div :class="['module-visual', `is-${item.visual}`]" :aria-label="`${item.title}视觉示意`">
          <div class="module-visual-stage">
            <div class="visual-window">
              <div class="visual-window-head">
                <span>{{ String(index + 1).padStart(2, "0") }}</span>
                <strong>{{ item.title }}</strong>
              </div>
              <div class="visual-artboard">
                <div class="visual-product-shape">
                  <Icon :name="item.icon" />
                </div>
                <div class="visual-lines">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
            <div class="visual-badge">{{ item.status }}</div>
          </div>
        </div>
      </article>
    </section>

    <section class="home-workflow studio-panel">
      <div>
        <span class="home-kicker">Workflow</span>
        <h2>从商品资料到可复用素材库。</h2>
        <p>输入商品名称、卖点和参考图后，系统会把生成结果、文案和历史记录同步到云端，方便反复修改、重新生成和下载使用。</p>
      </div>
      <div class="workflow-steps">
        <div v-for="(item, index) in workflow" :key="item" class="workflow-step">
          <span>{{ String(index + 1).padStart(2, "0") }}</span>
          <strong>{{ item }}</strong>
        </div>
      </div>
    </section>

    <footer>
      EcomImgGen · 历史记录云端同步 · GitHub
      <a
        class="github-link"
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
</template>
