/**
 * The ONE kill-switch parser of the 2026-10-21 lane-lifecycle wave (third
 * review, 2026-10-22). Its seven switches used to read two ways — three only
 * on the exact value '1', four on '1' / 'true' / 'on' — so an operator rolling
 * the whole wave back with every switch set to 'true' turned four features off
 * and left the ticket drain's gap paths, the display-parent stamping and the
 * extended branch-janitor rules running. A switch is ON for '1', 'true' or
 * 'on' (trimmed, any case); anything else (unset, '', '0', 'false') is OFF.
 * A leaf: no imports, so every reader (feedback, fleet, coding, platform) can
 * load it without a cycle.
 */
export function killSwitchOn(value: unknown): boolean {
  const s = String(value ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
}
