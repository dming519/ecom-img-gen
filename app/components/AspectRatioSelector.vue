<script setup lang="ts">
import { ASPECT_RATIO_OPTIONS } from "@/lib/imageOptions"
import type { AspectRatio } from "@/lib/types"
import SegmentedControl from "./SegmentedControl.vue"

withDefaults(defineProps<{
  value: AspectRatio
  disabled?: boolean
}>(), {
  disabled: false,
})

const emit = defineEmits<{
  change: [value: AspectRatio]
}>()
</script>

<template>
  <SegmentedControl
    aria-label="画面比例"
    ariaLabel="画面比例"
    :value="value"
    :options="ASPECT_RATIO_OPTIONS"
    :disabled="disabled"
    @change="emit('change', $event as AspectRatio)"
  />
</template>
