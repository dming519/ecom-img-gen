<script setup lang="ts">
import { shallowRef } from "vue"
import Icon from "./Icon.vue"

withDefaults(defineProps<{
  title: string
  count?: number
}>(), {
  count: 0,
})

const open = shallowRef(false)

function toggleOpen() {
  open.value = !open.value
}

function closeDrawer() {
  open.value = false
}
</script>

<template>
  <aside :class="['history-drawer', { 'is-open': open }]" aria-label="历史记录">
    <button
      type="button"
      class="history-drawer-toggle"
      :aria-label="`打开${title}，${count} 条历史`"
      :aria-expanded="open"
      @click="toggleOpen"
    >
      <Icon name="queue" />
      <span>历史</span>
      <em>{{ count }}</em>
    </button>

    <section class="history-drawer-panel">
      <div class="history-drawer-head">
        <div>
          <strong>{{ title }}</strong>
          <span>{{ count }} 条</span>
        </div>
        <button type="button" class="history-drawer-close" aria-label="收起历史" @click="closeDrawer">
          <Icon name="close" />
        </button>
      </div>
      <div class="history-drawer-body">
        <slot />
      </div>
    </section>
  </aside>
</template>
