<script setup lang="ts">
import { onBeforeUnmount, watch } from "vue"
import Icon from "./Icon.vue"

const props = withDefaults(defineProps<{
  src?: string | null
  alt?: string
}>(), {
  src: null,
  alt: "Preview",
})

const emit = defineEmits<{
  close: []
}>()

function onKey(event: KeyboardEvent) {
  if (event.key === "Escape") emit("close")
}

watch(
  () => props.src,
  (src) => {
    if (typeof window === "undefined") return
    document.removeEventListener("keydown", onKey)
    document.body.style.overflow = ""
    if (!src) return
    document.addEventListener("keydown", onKey)
    document.body.style.overflow = "hidden"
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (typeof window === "undefined") return
  document.removeEventListener("keydown", onKey)
  document.body.style.overflow = ""
})
</script>

<template>
  <div
    v-if="src"
    class="lightbox"
    @click="event => event.target === event.currentTarget && emit('close')"
  >
    <button class="lightbox-x" type="button" aria-label="关闭" @click="emit('close')">
      <Icon name="close" />
    </button>
    <img :src="src" :alt="alt">
  </div>
</template>
