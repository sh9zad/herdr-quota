// System vitals: CPU, memory, disk and battery as gauges, a CPU trace, load and thermal state.
// macOS and Linux. Polls every 5 s while its panel is shown. props.panel: the layout node to
// watch for hidden (skips polling then).
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props as blockProps } from "herdr";
import { C, ACCENT, COMPACT_BELOW, a, label, txt, gauge, sparkline, frame, sh, panelHidden } from "./hud.js";

const EVERY = 5000, HISTORY = 72; // 6 minutes of CPU samples

const SCRIPT = `
case "$(uname)" in
Darwin)
  # cpu: iostat's second sample (1 s), us+sy
  iostat -c 2 -w 1 2>/dev/null | tail -1 | awk '{print "cpu="$(NF-5)+$(NF-4)}'
  echo "cores=$(sysctl -n hw.ncpu)"
  echo "load=$(sysctl -n vm.loadavg | awk '{print $2}')"
  free=$(memory_pressure 2>/dev/null | awk -F': ' '/free percentage/{gsub("%","",$2);print $2}')
  echo "mem=$((100-\${free:-0}))"
  echo "memtotal=$(sysctl -n hw.memsize)"
  df -k /System/Volumes/Data 2>/dev/null | tail -1 | awk '{print "disk="$5; print "diskfree="$4*1024}' | tr -d %
  b=$(pmset -g batt 2>/dev/null)
  echo "$b" | grep -q InternalBattery && {
    echo "batt=$(echo "$b" | grep -o '[0-9]*%' | head -1 | tr -d %)"
    echo "battstate=$(echo "$b" | awk -F'; ' 'NR==2{print $2}')"
    echo "battleft=$(echo "$b" | grep -o '[0-9]*:[0-9]* remaining' | cut -d' ' -f1)"
  }
  echo "$b" | head -1 | grep -q "AC Power" && echo "power=AC" || echo "power=BATTERY"
  t=$(pmset -g therm 2>/dev/null)
  lvl=$(echo "$t" | awk -F'= ' '/CPU_Speed_Limit/{print $2}')
  [ -n "$lvl" ] && echo "speedlimit=$lvl"
  echo "$t" | grep -qi "warning level.*[1-9]" && echo "thermal=WARN"
  ;;
*)
  read -r _ a1 b1 c1 d1 e1 f1 g1 _ < /proc/stat; sleep 1; read -r _ a2 b2 c2 d2 e2 f2 g2 _ < /proc/stat
  busy=$(( (a2+b2+c2+f2+g2) - (a1+b1+c1+f1+g1) )); idle=$(( (d2+e2) - (d1+e1) ))
  echo "cpu=$(( 100*busy/(busy+idle+1) ))"
  echo "cores=$(nproc)"
  echo "load=$(cut -d' ' -f2 /proc/loadavg)"
  awk '/MemTotal/{t=$2}/MemAvailable/{v=$2}END{print "mem="int(100-100*v/t); print "memtotal="t*1024}' /proc/meminfo
  df -k / | tail -1 | awk '{print "disk="$5; print "diskfree="$4*1024}' | tr -d %
  for d in /sys/class/power_supply/BAT*; do [ -d "$d" ] && { echo "batt=$(cat $d/capacity)"; echo "battstate=$(cat $d/status | tr A-Z a-z)"; break; }; done
  [ "$(cat /sys/class/power_supply/A*/online 2>/dev/null | head -1)" = 1 ] && echo "power=AC" || echo "power=BATTERY"
  t=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null); [ -n "$t" ] && echo "tempc=$((t/1000))"
  ;;
esac`;

function parse(out) {
  const v = {};
  for (const line of out.split("\n")) { const i = line.indexOf("="); if (i > 0) v[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  const num = (k) => (v[k] != null && v[k] !== "" && !isNaN(Number(v[k])) ? Number(v[k]) : null);
  return {
    cpu: num("cpu"), cores: num("cores"), load: num("load"), mem: num("mem"), memTotal: num("memtotal"),
    disk: num("disk"), diskFree: num("diskfree"), batt: num("batt"), battState: v.battstate || null,
    battLeft: v.battleft || null, power: v.power || null, speedLimit: num("speedlimit"),
    thermalWarn: v.thermal === "WARN", tempC: num("tempc"),
  };
}

const gb = (bytes) => (bytes == null ? "--" : bytes >= 1e12 ? `${(bytes / 1e12).toFixed(1)}T` : `${Math.round(bytes / 1e9)}G`);
// Usage gauges: high is bad. Battery: low is bad.
const useColor = (p, accent) => (p >= 90 ? C.crit : p >= 75 ? C.warn : accent);
const battColor = (p, accent, charging) => (charging ? C.ok : p <= 10 ? C.crit : p <= 25 ? C.warn : accent);

export default class Vitals extends View {
  init(props, cx) {
    this.panel = (props ?? blockProps() ?? {}).panel ?? null;
    this.width = 380;
    this.v = null;
    this.cpuHist = [];
    const poll = (cx) => {
      if (this.busy || panelHidden(this.panel)) return;
      this.busy = true;
      cx.spawn(async (cx) => {
        try {
          const r = await sh(SCRIPT, [], 10000);
          this.v = parse(r.stdout ?? "");
          if (this.v.cpu != null) { this.cpuHist.push(this.v.cpu); if (this.cpuHist.length > HISTORY) this.cpuHist.shift(); }
        } finally { this.busy = false; cx.notify(); }
      });
    };
    poll(cx);
    cx.timer.every(EVERY, poll);
  }

  gauges(compact) {
    const v = this.v ?? {}, A = ACCENT.vitals;
    const charging = /charg/.test(v.battState ?? "") && !/discharg/.test(v.battState ?? "") || v.battState === "charged" || v.battState === "full";
    const list = [
      { k: "cpu", fill: v.cpu, caption: v.cores ? `${v.cores} CORES` : "", tag: "CPU", color: useColor(v.cpu ?? 0, A) },
      { k: "mem", fill: v.mem, caption: `OF ${gb(v.memTotal)}`, tag: "MEM", color: useColor(v.mem ?? 0, A) },
      { k: "disk", fill: v.disk, caption: `${gb(v.diskFree)} FREE`, tag: "DISK", color: useColor(v.disk ?? 0, A) },
    ];
    if (v.batt != null) list.push({ k: "batt", fill: v.batt, caption: v.battLeft && v.battLeft !== "0:00" ? `${v.battLeft} LEFT` : (v.battState ?? "").toUpperCase(), tag: charging ? "BAT ⚡" : "BAT", color: battColor(v.batt, A, charging) });
    return list;
  }

  render(cx) {
    const compact = this.width < COMPACT_BELOW, A = ACCENT.vitals, v = this.v;
    const onSize = (size, cx) => { if (Math.abs(this.width - size.width) > 2) { this.width = size.width; cx.notify(); } };
    const loading = !v;
    let body;
    if (loading) {
      body = label("SAMPLING", C.dim, 9).loop("opacity", { from: 0.3, to: 1, period: 1400 });
    } else if (compact) {
      body = v_flex().items_center().gap(6).children(this.gauges(true).map((g) =>
        gauge({ id: `c-${g.k}`, size: 62, fill: g.fill ?? 0, value: g.fill == null ? "--" : Math.round(g.fill), unit: "%", tag: g.tag, color: g.color, compact: true })));
    } else {
      const inner = this.width - 32;
      const cols = inner >= 560 ? 4 : 2;
      const size = Math.max(96, Math.min(132, Math.floor((inner - (cols - 1) * 10) / cols)));
      const gs = this.gauges(false);
      const rows = [];
      for (let i = 0; i < gs.length; i += cols) rows.push(gs.slice(i, i + cols));
      const thermal = v.thermalWarn || (v.speedLimit != null && v.speedLimit < 100)
        ? [`THROTTLED${v.speedLimit != null ? ` ${v.speedLimit}%` : ""}`, C.warn]
        : [v.tempC != null ? `${v.tempC}°C` : "NOMINAL", C.ok];
      const stat = (k, val, col = C.text) => h_flex().justify_between().w_full().child(label(k, C.dim, 8.5)).child(txt(val, 11, col));
      const loadPct = v.load != null && v.cores ? (v.load / v.cores) * 100 : null;
      body = v_flex().w_full().gap(14)
        .children(rows.map((row, ri) => h_flex().w_full().justify_around().children(row.map((g) =>
          gauge({ id: `g-${g.k}`, size, fill: g.fill ?? 0, value: g.fill == null ? "--" : Math.round(g.fill), unit: "%", caption: g.caption, tag: g.tag, color: g.color })))))
        .child(v_flex().w_full().gap(6)
          .child(h_flex().w_full().justify_between().child(label("CPU TRACE · 6 MIN", C.mid, 8.5)).child(label(`${Math.round(v.cpu ?? 0)}%`, A, 8.5)))
          .child(div().w_full().border(1).border_color(C.line).bg(C.plate).p(4)
            .child(sparkline(this.cpuHist, Math.max(40, inner - 10), 44, A))))
        .child(v_flex().w_full().gap(4)
          .child(stat("LOAD 1M", v.load != null ? `${v.load.toFixed(2)} / ${v.cores} CORES` : "--", loadPct != null && loadPct > 80 ? C.warn : C.text))
          .child(stat("THERMAL", thermal[0], thermal[1]))
          .child(stat("POWER", v.power === "AC" ? "AC" : v.power === "BATTERY" ? "BATTERY" : "--", v.power === "BATTERY" ? C.warn : C.text)));
    }
    return frame({
      title: "SYSTEM", sub: "VITALS", accent: A, compact, compactTag: "SYS", onSize, id: "vitals-root",
      right: label(v ? `5S · ${this.busy ? "◉" : "○"}` : "", C.dim, 8.5),
      body,
    });
  }
}
