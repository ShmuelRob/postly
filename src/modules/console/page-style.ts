// The console's stylesheet ("quiet switchboard"): tokens for light and dark, mobile first.
// Inlined into the page, since the console loads nothing from outside.

export const CSS = `
:root{
  color-scheme:light;
  --font:"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,BlinkMacSystemFont,Roboto,"Noto Sans","Noto Sans Hebrew","Arial Hebrew",Arial,sans-serif;
  --mono:ui-monospace,"Cascadia Mono","SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --fs-xs:11.5px;--fs-sm:12.5px;--fs-md:14px;--fs-lg:16px;--fs-xl:20px;--fs-2xl:26px;
  --lh:1.45;--lh-tight:1.15;
  --sp-1:4px;--sp-2:8px;--sp-3:12px;--sp-4:16px;--sp-5:24px;--sp-6:32px;--sp-7:48px;
  --r-xs:4px;--r-sm:6px;--r-md:8px;--r-lg:12px;--r-pill:999px;--r-bubble:14px;
  --gutter:16px;--max:1440px;--rail:3px;
  --bg:#EEF1F4;--surface:#FFFFFF;--surface-2:#F6F8FA;--hover:#F1F4F7;--selected:#EBEDFB;
  --line:#DFE4EA;--line-strong:#C6CDD6;
  --ink:#16202B;--ink-2:#46515F;--ink-3:#5E6977;
  --accent:#3E48C8;--accent-hover:#343DB0;--on-accent:#FFFFFF;--link:#3640B8;--focus:#5560DA;
  --series:#5560DA;--series-hover:#3E48C8;
  --code-bg:#F3F5F8;--top-bg:rgba(255,255,255,.94);
  --chat-bg:#E7ECEF;--bubble-in:#FFFFFF;--bubble-out:#DCF2E2;--bubble-edge:rgba(22,32,43,.08);
  --shadow:rgba(22,32,43,.08);--shadow-lg:rgba(22,32,43,.22);--scrim:rgba(14,20,28,.45);
  --good:#1A7342;--good-bg:#E2F2E8;
  --info:#1D5CA8;--info-bg:#E3EDF9;
  --progress:#0A6B7C;--progress-bg:#DDF1F4;
  --human:#83379F;--human-bg:#F4E7F9;
  --warn:#8A5200;--warn-bg:#FCEFD6;
  --bad:#B0212B;--bad-bg:#FBE5E6;--on-bad:#FFFFFF;
  --neutral:#56606D;--neutral-bg:#ECEFF3;
}
@media (prefers-color-scheme:dark){:root{
  color-scheme:dark;
  --bg:#0E1318;--surface:#151B23;--surface-2:#1A212B;--hover:#1D2530;--selected:#22264A;
  --line:#26303C;--line-strong:#35404E;
  --ink:#E5E9EF;--ink-2:#B0B9C5;--ink-3:#929DAC;
  --accent:#7F87F5;--accent-hover:#959CFF;--on-accent:#0E1318;--link:#9AA1FF;--focus:#959CFF;
  --series:#7F87F5;--series-hover:#A5ABFF;
  --code-bg:#11171E;--top-bg:rgba(21,27,35,.94);
  --chat-bg:#0B1015;--bubble-in:#1C232D;--bubble-out:#1B3528;--bubble-edge:rgba(0,0,0,.35);
  --shadow:rgba(0,0,0,.3);--shadow-lg:rgba(0,0,0,.6);--scrim:rgba(0,0,0,.6);
  --good:#62D394;--good-bg:#14301F;
  --info:#86B9F6;--info-bg:#13263D;
  --progress:#5FCBDB;--progress-bg:#0E2B32;
  --human:#D79BEF;--human-bg:#2D1937;
  --warn:#F2B75A;--warn-bg:#32240B;
  --bad:#FF8D92;--bad-bg:#3A1519;--on-bad:#1A0A0B;
  --neutral:#A9B2BF;--neutral-bg:#232B36;
}}
@media (min-width:720px){:root{--gutter:24px}}

/* tone plumbing: any element with data-tone gets --t-fg / --t-bg */
[data-tone]{--t-fg:var(--neutral);--t-bg:var(--neutral-bg)}
[data-tone=good]{--t-fg:var(--good);--t-bg:var(--good-bg)}
[data-tone=info]{--t-fg:var(--info);--t-bg:var(--info-bg)}
[data-tone=progress]{--t-fg:var(--progress);--t-bg:var(--progress-bg)}
[data-tone=human]{--t-fg:var(--human);--t-bg:var(--human-bg)}
[data-tone=warn]{--t-fg:var(--warn);--t-bg:var(--warn-bg)}
[data-tone=bad]{--t-fg:var(--bad);--t-bg:var(--bad-bg)}

/* base */
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;min-height:100dvh;background:var(--bg);color:var(--ink);font:var(--fs-md)/var(--lh) var(--font);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:2px}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:var(--r-xs)}
h1,h2,h3,h4,p{margin:0}
h1{font-size:var(--fs-xl);font-weight:600;letter-spacing:-.01em}
h2{font-size:var(--fs-lg);font-weight:600}
h3{font-size:var(--fs-md);font-weight:600}
code,.mono{font-family:var(--mono);font-size:.9em}
.muted{color:var(--ink-3)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.end{margin-left:auto}
.facts{display:flex;flex-wrap:wrap;gap:2px 12px;font-size:var(--fs-xs);color:var(--ink-3)}
.facts b{font-weight:600;color:var(--ink-2)}
.id{font-family:var(--mono);font-size:var(--fs-xs);color:var(--ink-3)}
.hash{font-family:var(--mono);font-size:var(--fs-xs);color:var(--ink-2);background:var(--code-bg);border:1px solid var(--line);padding:0 5px;border-radius:var(--r-xs)}
[dir=auto]{unicode-bidi:plaintext}

/* top bar + tabs */
.top{background:var(--top-bg);border-bottom:1px solid var(--line);z-index:30}
@media (min-width:760px){.top{position:sticky;top:0;backdrop-filter:blur(8px)}}
.top-row,.tabs{max-width:var(--max);margin:0 auto;padding:0 var(--gutter)}
.top-row{display:flex;align-items:center;gap:var(--sp-3);min-height:44px;padding-top:6px}
.brand{display:flex;align-items:baseline;gap:6px;color:var(--ink);font-weight:650;font-size:var(--fs-lg);letter-spacing:-.01em}
.brand:hover{text-decoration:none}
.brand span{font-weight:400;color:var(--ink-3)}
.env{font-size:var(--fs-xs);font-weight:600;padding:1px 8px;border-radius:var(--r-pill);background:var(--t-bg);color:var(--t-fg)}
.pulse{display:inline-flex;align-items:center;gap:6px;font-size:var(--fs-xs);color:var(--ink-2)}
.pulse::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--t-fg)}
.actor{margin-left:auto;font-size:var(--fs-sm);color:var(--ink-3);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45vw}
.tabs{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.tabs::-webkit-scrollbar{display:none}
.tab{flex:none;display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 10px;color:var(--ink-2);font-weight:550;border-bottom:2px solid transparent;white-space:nowrap}
.tab:first-child{margin-left:-10px}
.tab:hover{color:var(--ink);text-decoration:none}
.tab[aria-current=page]{color:var(--ink);border-bottom-color:var(--accent)}
.tab .n{min-width:18px;height:18px;padding:0 5px;border-radius:var(--r-pill);font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;background:var(--t-bg);color:var(--t-fg)}
@media (min-width:400px){.tab{padding:0 12px}.tab:first-child{margin-left:-12px}}

/* banner (global pause, handoff) */
.banner{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;padding:10px var(--gutter);background:var(--t-bg);border-bottom:1px solid var(--line);box-shadow:inset var(--rail) 0 0 var(--t-fg)}
.banner strong{color:var(--t-fg);font-weight:650}
.banner .facts{color:var(--ink-2)}
.banner .btn{margin-left:auto}
.banner.inline{border:1px solid var(--line);border-radius:var(--r-md);padding:8px 12px}

/* page */
.wrap{max-width:var(--max);margin:0 auto;padding:var(--sp-4) var(--gutter) var(--sp-7)}
.page-h{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--sp-2) var(--sp-3);margin-bottom:var(--sp-4)}
.sect{margin-top:var(--sp-5)}
.sect:first-child{margin-top:0}
.sect-h{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px var(--sp-2);margin-bottom:var(--sp-2)}
.sect-h .meta{font-size:var(--fs-sm);color:var(--ink-3)}
.sect-h .end{display:flex;gap:6px}
.box{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);overflow:hidden}
.box-pad{padding:var(--sp-3) var(--sp-4)}
.grid-ov,.grid-mg{display:grid;gap:var(--sp-5);grid-template-columns:minmax(0,1fr)}
@media (min-width:1180px){
  .grid-ov{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
  .grid-mg{grid-template-columns:minmax(0,2fr) minmax(340px,1fr);align-items:start}
  .span-2{grid-column:1/-1}
}
.stack>*+*{margin-top:var(--sp-5)}

/* stat tiles: one strip, divided by hairlines */
.tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:var(--r-lg);overflow:hidden}
@media (min-width:720px){.tiles{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (min-width:1180px){.tiles{grid-template-columns:repeat(6,minmax(0,1fr))}}
.tile{position:relative;display:flex;flex-direction:column;gap:4px;min-width:0;padding:12px 14px 14px;background:var(--surface);color:var(--ink)}
a.tile:hover{background:var(--hover);text-decoration:none}
.tile[data-tone]{box-shadow:inset var(--rail) 0 0 var(--t-fg)}
.tile-l{font-size:var(--fs-sm);color:var(--ink-2);font-weight:550}
.tile-v{font-size:var(--fs-2xl);line-height:var(--lh-tight);font-weight:600;letter-spacing:-.02em}
.tile-v small{font-size:var(--fs-md);font-weight:500;color:var(--ink-3);letter-spacing:0;margin-left:4px}
.tile-s{font-size:var(--fs-xs);color:var(--ink-3)}
.mini{list-style:none;margin:2px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:2px 10px;font-size:var(--fs-xs);color:var(--ink-2)}
.mini li{display:inline-flex;align-items:center;gap:5px}
.mini li::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--t-fg)}
.mini b{font-weight:650;color:var(--ink)}
.ratio{display:flex;gap:2px;height:6px;margin-top:4px}
.ratio i{display:block;background:var(--t-fg);border-radius:2px;min-width:3px}

/* chart */
.chart{margin:0;padding:var(--sp-3) var(--sp-4) var(--sp-3)}
.chart-h{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;margin-bottom:var(--sp-2)}
.chart-h .meta{font-size:var(--fs-sm);color:var(--ink-3)}
.spark{display:block;width:100%;height:auto;overflow:visible}
.spark .bar{fill:var(--series)}
.spark .bar.zero{fill:var(--line-strong)}
.spark .hit{fill:transparent}
.spark .base{stroke:var(--line-strong);stroke-width:1}
.spark .tip{font:600 9px var(--font);fill:var(--ink);opacity:0;pointer-events:none}
.spark .g:hover .bar,.spark .g:focus .bar{fill:var(--series-hover)}
.spark .g:hover .tip,.spark .g:focus .tip,.spark .g.last .tip{opacity:1}
.spark .g:hover~.g.last .tip,.spark .g:focus~.g.last .tip{opacity:0}
.spark .g:focus{outline:none}
.chart-axis{display:flex;justify-content:space-between;font-size:var(--fs-xs);color:var(--ink-3);margin-top:4px}
.chart-table{margin-top:6px;font-size:var(--fs-xs)}
.chart-table summary{color:var(--link);cursor:pointer;width:max-content}
.chart-table table{border-collapse:collapse;margin-top:6px}
.chart-table td{padding:2px 12px 2px 0}

/* feed lists (recent failures, turns, runs) */
.feed{list-style:none;margin:0;padding:0}
.feed>li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;padding:10px 14px;border-top:1px solid var(--line)}
.feed>li:first-child{border-top:0}
.feed>li[data-tone]{box-shadow:inset var(--rail) 0 0 var(--t-fg)}
.feed .title{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0;font-weight:550}
.feed .when{font-size:var(--fs-xs);color:var(--ink-3);white-space:nowrap}
.feed .err{grid-column:1/-1;font-family:var(--mono);font-size:var(--fs-xs);color:var(--bad);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.feed .facts{grid-column:1/-1}

/* badges and chips */
.badge{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px 0 7px;border-radius:var(--r-pill);background:var(--t-bg);color:var(--t-fg);font-size:var(--fs-xs);font-weight:600;line-height:1;white-space:nowrap;vertical-align:middle}
.badge::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}
.badge[data-tone=info]::before,.badge[data-tone=neutral]::before{background:transparent;box-shadow:inset 0 0 0 1.5px currentColor}
.badge[data-tone=warn]::before,.badge[data-tone=bad]::before{border-radius:1px;transform:rotate(45deg) scale(.9)}
.badge[data-tone=progress]::before{animation:blink 1.6s ease-in-out infinite}
.badge.strike{text-decoration:line-through;text-decoration-thickness:1px}
.badge.bare::before{display:none}
@keyframes blink{50%{opacity:.25}}
.count{min-width:20px;height:20px;padding:0 6px;border-radius:var(--r-pill);display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;background:var(--t-fg);color:var(--surface)}
.chips{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding:2px 0}
.chips::-webkit-scrollbar{display:none}
.chip{flex:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:var(--r-pill);border:1px solid var(--line);background:var(--surface);color:var(--ink-2);font-size:var(--fs-sm)}
.chip:hover{text-decoration:none;border-color:var(--line-strong)}
.chip[aria-current=true]{background:var(--ink);border-color:var(--ink);color:var(--surface)}
.chip .n{opacity:.7}

/* tables -> cards under 720px */
.tbl{width:100%;border-collapse:separate;border-spacing:0}
.tbl th{text-align:left;font-size:var(--fs-sm);font-weight:600;color:var(--ink-3);padding:8px 12px;background:var(--surface-2);border-bottom:1px solid var(--line);white-space:nowrap}
.tbl td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
.tbl tbody tr:last-child td{border-bottom:0}
.tbl tbody tr:hover td{background:var(--hover)}
.tbl tr[data-tone] td:first-child{box-shadow:inset var(--rail) 0 0 var(--t-fg)}
.tbl .r{text-align:right}
.tbl .nowrap{white-space:nowrap}
.tbl .name{font-weight:600}
.tbl .detail{font-size:var(--fs-sm);color:var(--ink-2);max-width:420px;overflow-wrap:anywhere}
.tbl-scroll{overflow-x:auto}
@media (max-width:719.98px){
  .tbl.cards thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
  .tbl.cards,.tbl.cards tbody,.tbl.cards td{display:block}
  .tbl.cards tr{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px 12px;padding:12px 14px;border-bottom:1px solid var(--line)}
  .tbl.cards tbody tr:last-child{border-bottom:0}
  .tbl.cards tr[data-tone]{box-shadow:inset var(--rail) 0 0 var(--t-fg)}
  .tbl.cards tr[data-tone] td:first-child{box-shadow:none}
  .tbl.cards td{padding:0;border:0;min-width:0}
  .tbl.cards tbody tr:hover td{background:none}
  .tbl.cards td[data-label]::before{content:attr(data-label);display:block;font-size:var(--fs-xs);color:var(--ink-3);margin-bottom:2px}
  .tbl.cards td.primary,.tbl.cards td.wide,.tbl.cards td.actions{grid-column:1/-1}
  .tbl.cards td.actions .actions{justify-content:flex-start}
  .tbl.cards .r{text-align:left}
}

/* buttons */
.btn{appearance:none;font:inherit;font-size:var(--fs-sm);font-weight:550;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:0 12px;border-radius:var(--r-md);border:1px solid var(--line-strong);background:var(--surface);color:var(--ink);cursor:pointer;white-space:nowrap;text-decoration:none}
.btn:hover{background:var(--hover);text-decoration:none}
.btn:disabled{opacity:.55;cursor:progress}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.btn.primary:hover{background:var(--accent-hover)}
.btn.danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 45%,var(--line))}
.btn.danger:hover{background:var(--bad-bg)}
.btn.danger-solid{background:var(--bad);border-color:var(--bad);color:var(--on-bad)}
.btn.good{color:var(--good);border-color:color-mix(in srgb,var(--good) 45%,var(--line))}
.btn.good:hover{background:var(--good-bg)}
.btn.quiet{background:transparent;border-color:transparent;color:var(--ink-2)}
.btn.quiet:hover{background:var(--hover)}
.btn.sm{min-height:26px;padding:0 9px;font-size:var(--fs-xs)}
@media (pointer:coarse){.btn{min-height:40px}.btn.sm{min-height:34px;padding:0 12px}}
.actions{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;align-items:center}
.back{display:inline-flex;align-items:center;gap:4px;min-height:36px;font-weight:550}
.back::before{content:"";width:7px;height:7px;border-left:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg);margin-right:2px}

/* forms */
.in{font:inherit;font-size:var(--fs-md);color:var(--ink);background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--r-md);padding:6px 10px;min-height:34px;width:100%;min-width:0}
.in:focus{outline:2px solid var(--focus);outline-offset:-1px;border-color:transparent}
.in::placeholder{color:var(--ink-3)}
select.in{padding-right:28px}
textarea.in{font-family:var(--mono);font-size:var(--fs-sm);line-height:1.55;min-height:320px;resize:vertical;tab-size:2;white-space:pre;direction:ltr}
.in.cell{min-height:28px;padding:3px 7px;font-size:var(--fs-sm);width:100%;min-width:64px}
@media (max-width:719.98px){.in,.in.cell{font-size:16px;min-height:40px}}
.field{display:grid;gap:4px;min-width:0}
.field>span{font-size:var(--fs-sm);font-weight:550;color:var(--ink-2)}
.hint{font-size:var(--fs-xs);color:var(--ink-3)}
.form-grid{display:grid;gap:var(--sp-3);grid-template-columns:minmax(0,1fr)}
@media (min-width:720px){.form-grid{grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}}
.form-foot{display:flex;flex-wrap:wrap;align-items:flex-end;gap:var(--sp-2);margin-top:var(--sp-3)}
.form-foot .field{flex:1 1 220px}
.form-errors{color:var(--bad);font-size:var(--fs-sm)}
.form-errors:empty{display:none}
.form-errors ul{margin:4px 0 0;padding-left:18px;font-family:var(--mono);font-size:var(--fs-xs)}
.ctl{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:12px 14px;border-top:1px solid var(--line)}
.ctl:first-child{border-top:0}
.ctl-l{flex:1 1 180px;min-width:0}
.ctl-l b{display:block;font-weight:600}
.ctl-l span{font-size:var(--fs-xs);color:var(--ink-3)}

/* disclosure */
details>summary{cursor:pointer;list-style:none}
details>summary::-webkit-details-marker{display:none}
.disc>summary{display:flex;align-items:center;gap:8px;padding:10px 14px;min-height:44px}
.disc>summary::before{content:"";flex:none;width:7px;height:7px;border-right:1.5px solid var(--ink-3);border-bottom:1.5px solid var(--ink-3);transform:rotate(-45deg);transition:transform .15s ease}
.disc[open]>summary::before{transform:rotate(45deg)}
.disc>summary:hover{background:var(--hover)}
.disc>summary .end{display:flex;gap:6px;align-items:center}
.disc-body{padding:0 14px 14px}

/* JSON */
.json{border:1px solid var(--line);border-radius:var(--r-md);background:var(--code-bg);margin-top:var(--sp-2);overflow:hidden}
.json>summary{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:var(--fs-sm);font-weight:600}
.json>summary::before{content:"";width:6px;height:6px;border-right:1.5px solid var(--ink-3);border-bottom:1.5px solid var(--ink-3);transform:rotate(-45deg);transition:transform .15s}
.json[open]>summary::before{transform:rotate(45deg)}
.json>summary .meta{font-weight:400;color:var(--ink-3);font-size:var(--fs-xs)}
.json-tools{display:flex;justify-content:flex-end;padding:0 8px 4px}
.json pre{margin:0;padding:10px 12px;border-top:1px solid var(--line);overflow:auto;max-height:60vh;font:var(--fs-xs)/1.6 var(--mono);white-space:pre;tab-size:2;direction:ltr;unicode-bidi:isolate;color:var(--ink)}
.json.err pre{color:var(--bad);white-space:pre-wrap;overflow-wrap:anywhere}

/* conversations: list | thread | panel */
.is-convo .wrap{max-width:1680px}
.convo{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr)}
.convo>.col{display:none;min-width:0;min-height:0;flex-direction:column;background:var(--surface)}
.convo[data-view=list]>.c-list,.convo[data-view=thread]>.c-thread,.convo[data-view=panel]>.c-panel{display:flex}
@media (max-width:759.98px){
  .is-convo .wrap{padding:0 0 var(--sp-6)}
  .convo>.col{background:transparent}
  .convo>.c-list,.convo>.c-panel{background:var(--surface)}
}
@media (min-width:760px){
  body.is-convo{height:100dvh;display:flex;flex-direction:column;overflow:hidden}
  .is-convo .wrap{flex:1;min-height:0;width:100%;display:flex;flex-direction:column}
  .convo{flex:1;min-height:0;grid-template-columns:300px minmax(0,1fr);border:1px solid var(--line);border-radius:var(--r-lg);overflow:hidden;background:var(--surface)}
  .convo>.c-list{display:flex;border-right:1px solid var(--line)}
  .convo[data-view=list]>.c-thread{display:flex}
  .col-scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}
}
@media (min-width:1180px){
  .convo{grid-template-columns:300px minmax(0,1fr) 380px}
  .convo>.col{display:flex}
  .convo>.c-panel{border-left:1px solid var(--line)}
  .convo[data-view=list]{grid-template-columns:300px minmax(0,1fr)}
  .convo[data-view=list]>.c-panel{display:none}
  .only-narrow{display:none!important}
}
.col-h{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line);background:var(--surface);position:sticky;top:0;z-index:5;min-height:56px}
.col-h .who{flex:1;min-width:0}
.col-h .who h2{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.col-h .sub{display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center;margin-top:2px}
.list-h{display:grid;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--surface);z-index:5}
.search{position:relative}
.search .in{padding-left:32px}
.search svg{position:absolute;left:10px;top:50%;width:14px;height:14px;transform:translateY(-50%);stroke:var(--ink-3);fill:none;stroke-width:2}
.blist{list-style:none;margin:0;padding:0}
.bitem{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;padding:10px 14px;border-bottom:1px solid var(--line);color:var(--ink)}
.bitem:hover{background:var(--hover);text-decoration:none}
.bitem[aria-current=page]{background:var(--selected);box-shadow:inset var(--rail) 0 0 var(--accent)}
.bitem .name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bitem .when{font-size:var(--fs-xs);color:var(--ink-3);white-space:nowrap;text-align:right}
.bitem .preview{font-size:var(--fs-sm);color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
.bitem .preview .me{color:var(--ink-3)}
.bitem .tags{grid-column:1/-1;display:flex;gap:6px;align-items:center;margin-top:3px}

/* chat */
.chat{flex:1;display:flex;flex-direction:column;gap:2px;padding:12px 12px 20px;background:var(--chat-bg)}
@media (min-width:760px){.chat{padding:16px 20px 24px}}
.day{align-self:center;margin:14px 0 6px;padding:2px 10px;border-radius:var(--r-pill);background:var(--surface);border:1px solid var(--line);font-size:var(--fs-xs);color:var(--ink-2)}
.note{align-self:center;margin:8px 0;font-size:var(--fs-xs);color:var(--ink-3);text-align:center;max-width:80%}
.msg{display:flex;flex-direction:column;max-width:min(80%,540px)}
.msg:not(.cont){margin-top:8px}
.msg.in{align-self:flex-start}
.msg.out{align-self:flex-end}
.bubble{background:var(--bubble-in);color:var(--ink);border-radius:var(--r-bubble);padding:6px 10px 4px;box-shadow:0 1px 0 var(--bubble-edge);min-width:72px}
.msg.out .bubble{background:var(--bubble-out)}
.msg.in:not(.cont) .bubble{border-top-left-radius:4px}
.msg.out:not(.cont) .bubble{border-top-right-radius:4px}
.bubble .text{white-space:pre-wrap;overflow-wrap:anywhere;unicode-bidi:plaintext;text-align:start}
.bubble .stamp{display:flex;justify-content:flex-end;align-items:center;gap:6px;margin-top:1px;font-size:10.5px;color:var(--ink-2);direction:ltr;white-space:nowrap}
.bubble .kind{font-size:10.5px;color:var(--ink-2);font-style:italic}
.bubble .media{display:block;margin:-2px -6px 4px;border-radius:10px;overflow:hidden;max-width:280px}
.bubble .media img{display:block;width:100%;height:auto}
.bubble .voice{display:flex;align-items:center;gap:8px;font-size:var(--fs-sm);color:var(--ink-2)}
.bubble .voice::before{content:"";width:0;height:0;border-left:9px solid var(--ink-2);border-top:6px solid transparent;border-bottom:6px solid transparent}
.btn-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.btn-chips span{border:1px solid var(--line-strong);border-radius:var(--r-pill);padding:1px 10px;font-size:var(--fs-sm);color:var(--link);background:var(--surface)}
.reply-tag{display:inline-block;font-size:var(--fs-xs);color:var(--ink-2);border-left:2px solid var(--accent);padding-left:6px;margin-bottom:3px}

/* client panel */
.psec{border-bottom:1px solid var(--line)}
.psec>summary h3{font-size:var(--fs-md)}
.kv{display:grid;grid-template-columns:minmax(92px,auto) minmax(0,1fr);gap:4px 12px;margin:0;font-size:var(--fs-sm)}
.kv dt{color:var(--ink-3)}
.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.post{border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface);margin-top:var(--sp-2);overflow:hidden}
.post[data-tone]{box-shadow:inset var(--rail) 0 0 var(--t-fg)}
.post-h{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 10px;background:var(--surface-2);border-bottom:1px solid var(--line)}
.post-h .when{margin-left:auto;font-size:var(--fs-xs);color:var(--ink-3)}
.thumbs{display:flex;gap:6px;padding:10px 10px 4px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:thin}
.thumbs a{flex:none;scroll-snap-align:start;position:relative}
.thumbs img{display:block;width:92px;aspect-ratio:4/5;object-fit:cover;border-radius:var(--r-sm);border:1px solid var(--line);background:var(--surface-2)}
.thumbs .slide{position:absolute;right:4px;bottom:4px;font-size:10px;font-weight:700;padding:0 5px;border-radius:var(--r-pill);background:rgba(0,0,0,.6);color:#fff}
.caption{padding:6px 10px 8px;font-size:var(--fs-sm);white-space:pre-wrap;overflow-wrap:anywhere;unicode-bidi:plaintext;text-align:start}
.caption.clamp{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.sub-h{padding:8px 10px 2px;font-size:var(--fs-xs);font-weight:600;color:var(--ink-3)}
.versions,.pubs{list-style:none;margin:0;padding:0 10px 8px}
.versions li{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 0;border-top:1px dashed var(--line);font-size:var(--fs-sm)}
.versions li:first-child,.pubs li:first-child{border-top:0}
.versions .vn{font-weight:650;min-width:24px}
.versions .live{font-size:var(--fs-xs);font-weight:650;color:var(--good)}
.pubs li{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:2px 8px;padding:6px 0;border-top:1px dashed var(--line);font-size:var(--fs-sm)}
.pubs .net{font-weight:600;text-transform:capitalize}
.pubs .facts,.pubs .err{grid-column:1/-1}
.pubs .err{font-family:var(--mono);font-size:var(--fs-xs);color:var(--bad);overflow-wrap:anywhere}
.ro{margin:0;padding:8px 10px;border-top:1px solid var(--line);font-size:var(--fs-xs);color:var(--ink-3)}
.turn{border-top:1px solid var(--line)}
.turn:first-child{border-top:0}
.turn>summary{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 8px;padding:8px 0}
.turn>summary .title{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-weight:600}
.turn>summary .facts{grid-column:1/-1}
.turn>summary:hover .title{color:var(--link)}
.steps{list-style:none;counter-reset:s;margin:2px 0 10px;padding:0}
.steps>li{counter-increment:s;position:relative;margin-left:9px;padding:4px 0 10px 20px;border-left:1px solid var(--line);font-size:var(--fs-sm)}
.steps>li:last-child{border-left-color:transparent}
.steps>li::before{content:counter(s);position:absolute;left:-10px;top:3px;width:19px;height:19px;border-radius:50%;display:grid;place-items:center;background:var(--surface);border:1px solid var(--line-strong);font-size:10px;font-weight:650;color:var(--ink-2)}
.steps .step-h{display:flex;flex-wrap:wrap;gap:6px;align-items:center}

/* run detail */
.run-h{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-bottom:var(--sp-3)}
.run-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:var(--r-lg);overflow:hidden}
.run-kv>div{background:var(--surface);padding:10px 14px}
.run-kv dt{font-size:var(--fs-xs);color:var(--ink-3)}
.run-kv dd{margin:2px 0 0;font-weight:600;overflow-wrap:anywhere}

/* empty, dialog, toast */
.empty{padding:28px 16px;text-align:center;color:var(--ink-3);font-size:var(--fs-sm)}
.empty strong{display:block;color:var(--ink-2);font-size:var(--fs-md);font-weight:600;margin-bottom:2px}
.c-thread>.empty{margin:auto}
dialog.confirm{border:0;padding:0;width:min(440px,calc(100vw - 32px));border-radius:var(--r-lg);background:var(--surface);color:var(--ink);box-shadow:0 24px 60px var(--shadow-lg)}
dialog.confirm::backdrop{background:var(--scrim)}
.confirm form{display:grid;gap:12px;padding:18px}
.confirm .changes{margin:0;max-height:180px;overflow:auto;padding:8px 10px;border-radius:var(--r-md);background:var(--code-bg);border:1px solid var(--line);font:var(--fs-xs)/1.6 var(--mono)}
.confirm .who{font-size:var(--fs-xs);color:var(--ink-3)}
.confirm .row{display:flex;flex-direction:row-reverse;gap:8px}
@media (max-width:519.98px){dialog.confirm{width:100%;max-width:100%;margin:auto 0 0;border-radius:16px 16px 0 0}.confirm form{padding-bottom:calc(18px + env(safe-area-inset-bottom))}.confirm .row .btn{flex:1}}
#status{position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:50;max-width:calc(100vw - 32px);padding:10px 14px;border-radius:var(--r-md);background:var(--ink);color:var(--surface);font-size:var(--fs-sm);box-shadow:0 8px 24px var(--shadow-lg)}
#status:empty{display:none}
#status[data-tone=bad]{background:var(--bad);color:var(--on-bad)}
@media (prefers-reduced-motion:reduce){*,*::before{animation:none!important;transition:none!important}}
`;
