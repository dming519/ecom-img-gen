<script setup lang="ts">
import SegmentedControl from "./SegmentedControl.vue"

type ImageCountValue = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8"

const IMAGE_COUNT_OPTIONS: Array<{ label: string; value: ImageCountValue }> = [
  { label: "1", value: "1" },
  { label: "2", value: "2" },
  { label: "3", value: "3" },
  { label: "4", value: "4" },
  { label: "5", value: "5" },
  { label: "6", value: "6" },
  { label: "7", value: "7" },
  { label: "8", value: "8" },
]

withDefaults(defineProps<{
  value: number
  disabled?: boolean
}>(), {
  disabled: false,
})

const emit = defineEmits<{
  change: [value: number]
}>()

function toImageCountValue(value: number): ImageCountValue {
  const normalized = Math.min(8, Math.max(1, Math.round(value)))
  return String(normalized) as ImageCountValue
}
</script>

<template>
  <SegmentedControl
    aria-label="详情图张数"
    ariaLabel="详情图张数"
    :value="toImageCountValue(value)"
    :options="IMAGE_COUNT_OPTIONS"
    :disabled="disabled"
    class-name="count-segments"
    @change="emit('change', Number($event))"
  />
</template>
