Documentation copy only — kept next to the box's other static config per this
task's Owns row. The actual waking page served to browsers embeds its own
copy of this markup directly in workers/o11y/src/grafana/waking-page.ts (a
Worker has no filesystem at request time). If you change the brand logo,
update both this file and that one by hand.
