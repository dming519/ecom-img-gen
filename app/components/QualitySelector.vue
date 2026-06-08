<script setup lang="ts">
import { IMAGE_QUALITY_OPTIONS } from "@/lib/imageOptions"
import type { ImageQuality } from "@/lib/types"
import SegmentedControl from "./SegmentedControl.vue"

withDefaults(defineProps<{
  value: ImageQuality
  disabled?: boolean
}>(), {
  disabled: false,
})

const emit = defineEmits<{
  change: [value: ImageQuality]
}>()
</script>

<template>
  <SegmentedControl
    aria-label="清晰度"
    ariaLabel="清晰度"
    :value="value"
    :options="IMAGE_QUALITY_OPTIONS"
    :disabled="disabled"
    class-name="quality-segments"
    @change="emit('change', $event as ImageQuality)"
  />
</template>
