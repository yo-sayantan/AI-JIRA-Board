import { MotionGlobalConfig } from 'motion/react'

/**
 * Settings → "Motion & animations". The CSS half of this switch is the `jb-no-anim` class on <html>
 * (styles/index.css), which tames CSS animations and transitions only. This is the other half:
 * most of the board's movement — card entrances, drawer slides, layout shifts, exit animations — is
 * driven by framer-motion in JavaScript, which ignores CSS and, with `reducedMotion="user"`, obeys
 * only the operating system's setting. `skipAnimations` makes every motion animation finish on its
 * first frame, so the toggle genuinely turns movement off (and back on) without a reload.
 */
export function setMotionEnabled(enabled: boolean): void {
  MotionGlobalConfig.skipAnimations = !enabled
}

export function motionEnabled(): boolean {
  return !MotionGlobalConfig.skipAnimations
}
