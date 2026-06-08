<script setup lang="ts" generic="T extends string">
interface SegmentedOption<T extends string> {
  label: string
  value: T
}

withDefaults(defineProps<{
  value: T
  options: Array<SegmentedOption<T>>
  ariaLabel: string
  disabled?: boolean
  className?: string
}>(), {
  disabled: false,
  className: "",
})

const emit = defineEmits<{
  change: [value: T]
}>()
</script>

<template>
  <div
    :class="['segmented-control', className]"
    role="radiogroup"
    :aria-label="ariaLabel"
  >
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      role="radio"
      :aria-checked="option.value === value"
      :class="['segment-option', { 'is-active': option.value === value }]"
      :disabled="disabled"
      @click="emit('change', option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>
