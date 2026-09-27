<script setup lang="ts">
/*
 * What Jev sends off this machine, and where the key goes (#509): the privacy notice the outbound
 * call requires, kept visible on Settings › Integrations whatever state the Jev rows are in, since
 * the section has to explain itself either way.
 *
 * At the foot of the section rather than in the Jev row (#635): the design's Jev row carries a
 * one-line help and no notice, and handoff.md keeps every help string the component's own, so the
 * notice stays and stands where it does not move the rows the design draws (PR5 question: where
 * the design wants it).
 */
</script>

<template>
  <p class="privacy-notice">
    With Jev on, the prompt text and the list of providers and models this machine can launch are
    sent to TypeSafe's API (api.typesafe.ai) when a session starts, so it can choose one for you.
    The key is stored encrypted on this machine and is sent only to TypeSafe, to authenticate that
    request.
  </p>
</template>

<style scoped>
/* A settings row's help line, standing under the section's last row. */
.privacy-notice {
  padding: 10px 2px;
  font: 400 var(--fs-meta) / 1.35 var(--f-meta);
  color: var(--ink-faint);
}
</style>
