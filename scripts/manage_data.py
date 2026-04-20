#!/usr/bin/env python3
"""
manage_data.py — 臺灣轉公車 資料維護 GUI
使用方式：python scripts/manage_data.py

功能：
  - 顯示各縣市 原始資料 / 路線幾何 / 路網圖 狀態
  - 自動標記 FALLBACK shapes（點到點直線，非真實 TDX 路線）
  - 選取城市後可一鍵觸發：重新抓取 → 重建 graph → 重建 shapes
"""

import json
import queue
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import messagebox, scrolledtext, ttk
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
RAW_DIR    = SCRIPT_DIR / "raw"
OUTPUT_DIR = SCRIPT_DIR.parent / "public" / "data"
PYTHON     = sys.executable

ALL_CITIES = [
    ("taipei",           "台北市",    "Taipei"),
    ("newtaipei",        "新北市",    "NewTaipei"),
    ("keelung",          "基隆市",    "Keelung"),
    ("taoyuan",          "桃園市",    "Taoyuan"),
    ("hsinchu",          "新竹市",    "Hsinchu"),
    ("hsinchucounty",    "新竹縣",    "HsinchuCounty"),
    ("yilancounty",      "宜蘭縣",    "YilanCounty"),
    ("taichung",         "台中市",    "Taichung"),
    ("miaolicounty",     "苗栗縣",    "MiaoliCounty"),
    ("changhuacounty",   "彰化縣",    "ChanghuaCounty"),
    ("nantoucounty",     "南投縣",    "NantouCounty"),
    ("yunlincounty",     "雲林縣",    "YunlinCounty"),
    ("tainan",           "台南市",    "Tainan"),
    ("kaohsiung",        "高雄市",    "Kaohsiung"),
    ("chiayi",           "嘉義市",    "Chiayi"),
    ("chiayicounty",     "嘉義縣",    "ChiayiCounty"),
    ("pingtungcounty",   "屏東縣",    "PingtungCounty"),
    ("hualiencounty",    "花蓮縣",    "HualienCounty"),
    ("taitungcounty",    "台東縣",    "TaitungCounty"),
    ("penghucounty",     "澎湖縣",    "PenghuCounty"),
    ("kinmencounty",     "金門縣",    "KinmenCounty"),
    ("lienchiangcounty", "連江縣",    "LienchiangCounty"),
]


# ─── Status helpers ───────────────────────────────────────────────────────────

import datetime

def _file_summary(path: Path) -> str:
    """Return 'N items (XXX KB)' or 'missing'."""
    if not path.exists():
        return "missing"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        n  = len(data) if isinstance(data, list) else -1
        kb = path.stat().st_size / 1024
        return f"{n:,} ({kb:.0f} KB)" if n >= 0 else f"({kb:.0f} KB)"
    except Exception:
        return "error"

def _mtime(path: Path) -> str:
    """Return last-modified datetime string, or '—'."""
    if not path.exists():
        return "—"
    ts = path.stat().st_mtime
    return datetime.datetime.fromtimestamp(ts).strftime("%m/%d %H:%M")

def _shapes_info(key: str) -> tuple[str, str]:
    """Return (tag, display_text).  tag in: real | fallback | mixed | missing."""
    path = OUTPUT_DIR / f"{key}_shapes.json"
    if not path.exists():
        return "missing", "missing"
    try:
        shapes = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return "missing", "error"
    real = fb = 0
    for feat in shapes.values():
        if any(len(s) > 2 for s in feat.get("geometry", {}).get("coordinates", [])):
            real += 1
        else:
            fb += 1
    total = real + fb
    kb = round(path.stat().st_size / 1024, 1)
    if total == 0:
        return "missing", "missing"
    if fb == 0:
        return "real",     f"REAL  {total} routes  {kb} KB"
    if real == 0:
        return "fallback", f"FALLBACK  {total} routes  {kb} KB"
    ratio = fb / total
    if ratio >= 0.4:
        return "mixed",    f"MIXED  real={real} / fallback={fb}  {kb} KB"
    return "real",         f"REAL*  {total} routes (few fb)  {kb} KB"

def _graph_info(key: str) -> str:
    path = OUTPUT_DIR / f"{key}.json"
    if not path.exists():
        return "missing"
    kb = path.stat().st_size / 1024
    return f"{kb:.0f} KB"

def city_row(key: str, display: str, tdx: str) -> dict:
    prefix = tdx.lower()
    s_tag, s_txt = _shapes_info(key)
    stops_path = RAW_DIR / f"{prefix}_stops.json"
    return {
        "key": key, "display": display, "tdx": tdx,
        "stops":      _file_summary(stops_path),
        "routes":     _file_summary(RAW_DIR / f"{prefix}_routes.json"),
        "sor":        _file_summary(RAW_DIR / f"{prefix}_stop_of_route.json"),
        "updated":    _mtime(stops_path),
        "shapes_tag": s_tag,
        "shapes_txt": s_txt,
        "graph":      _graph_info(key),
        "is_ic":      False,
    }

def _intercity_row() -> dict:
    s_tag, s_txt = _shapes_info("intercity")
    stops_path = RAW_DIR / "intercity_stops.json"
    return {
        "key":        "__intercity__",
        "display":    "[InterCity]",
        "tdx":        "__intercity__",
        "stops":      _file_summary(stops_path),
        "routes":     _file_summary(RAW_DIR / "intercity_routes.json"),
        "sor":        _file_summary(RAW_DIR / "intercity_stop_of_route.json"),
        "updated":    _mtime(stops_path),
        "shapes_tag": s_tag,
        "shapes_txt": s_txt,
        "graph":      "N/A",
        "is_ic":      True,
    }


# ─── Main Application ─────────────────────────────────────────────────────────

class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("Taiwan Bus Data Manager")
        root.geometry("1060x740")
        root.minsize(800, 560)
        self._rows: dict[str, dict] = {}   # iid → row data
        self._running = False
        self._build_ui()
        self.refresh()

    # ── UI Construction ───────────────────────────────────────────────────────

    def _build_ui(self):
        # Toolbar
        bar = tk.Frame(self.root, bg="#2c3e50", pady=5, padx=6)
        bar.pack(fill=tk.X)
        for text, cmd in [
            ("Refresh",             self.refresh),
            ("Select FALLBACK",     self._sel_fallback),
            ("Select ALL",          self._sel_all),
            ("Clear Selection",     self._sel_clear),
        ]:
            tk.Button(bar, text=text, command=cmd,
                      bg="#3d5166", fg="white", relief=tk.FLAT,
                      padx=10, pady=3, cursor="hand2").pack(side=tk.LEFT, padx=3)

        self._status_lbl = tk.Label(bar, text="", fg="#aec6cf", bg="#2c3e50", font=("", 9))
        self._status_lbl.pack(side=tk.RIGHT, padx=8)

        # PanedWindow: table (top) / controls+output (bottom)
        pane = tk.PanedWindow(self.root, orient=tk.VERTICAL, sashwidth=5,
                               sashrelief=tk.RAISED, bg="#cccccc")
        pane.pack(fill=tk.BOTH, expand=True, padx=4, pady=4)

        # ── Status table ──────────────────────────────────────────────────────
        tf = tk.Frame(pane)
        pane.add(tf, minsize=240, stretch="always")

        cols = ("city", "updated", "stops", "routes", "sor", "shapes", "graph")
        self.tree = ttk.Treeview(tf, columns=cols, show="headings",
                                  selectmode="extended")
        headers = [
            ("city",    "縣市",              90,  "center"),
            ("updated", "原始資料更新時間",   110, "center"),
            ("stops",   "Stops",             155, "w"),
            ("routes",  "Routes",            130, "w"),
            ("sor",     "StopOfRoute",       130, "w"),
            ("shapes",  "Shapes Quality",    245, "w"),
            ("graph",   "Graph",             90,  "center"),
        ]
        for col, text, w, anchor in headers:
            self.tree.heading(col, text=text)
            self.tree.column(col, width=w, anchor=anchor, minwidth=50)

        vsb = ttk.Scrollbar(tf, orient="vertical",   command=self.tree.yview)
        hsb = ttk.Scrollbar(tf, orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=vsb.set, xscrollcommand=hsb.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        vsb.grid(row=0, column=1, sticky="ns")
        hsb.grid(row=1, column=0, sticky="ew")
        tf.rowconfigure(0, weight=1)
        tf.columnconfigure(0, weight=1)

        style = ttk.Style()
        style.configure("Treeview", rowheight=22, font=("Consolas", 9))
        style.configure("Treeview.Heading", font=("", 9, "bold"))

        self.tree.tag_configure("real",      foreground="#196b24")
        self.tree.tag_configure("fallback",  background="#fff3cd", foreground="#7c4a00")
        self.tree.tag_configure("mixed",     background="#fde8d8", foreground="#6b3200")
        self.tree.tag_configure("missing",   foreground="#888888")
        self.tree.tag_configure("intercity", background="#e8f4fd")

        self.tree.bind("<<TreeviewSelect>>", self._on_select)

        # ── Bottom panel ──────────────────────────────────────────────────────
        bot = tk.Frame(pane, bg="#f0f0f0")
        pane.add(bot, minsize=220)

        # Action frame
        af = tk.LabelFrame(bot, text="Actions  (applied to selected rows)",
                            padx=10, pady=6, bg="#f0f0f0", font=("", 9, "bold"))
        af.pack(fill=tk.X, padx=4, pady=(4, 2))

        self.do_fetch  = tk.BooleanVar(value=True)
        self.do_graph  = tk.BooleanVar(value=False)
        self.do_ic     = tk.BooleanVar(value=False)
        self.do_shapes = tk.BooleanVar(value=True)
        self.do_force  = tk.BooleanVar(value=False)

        tk.Checkbutton(af, bg="#f0f0f0", anchor="w",
            text="1. Re-fetch TDX raw data (fetch_tdx.py)  — always overwrites",
            variable=self.do_fetch).pack(anchor="w")
        tk.Checkbutton(af, bg="#f0f0f0", anchor="w",
            text="2. Rebuild graph (build_graph.py)",
            variable=self.do_graph).pack(anchor="w")

        ic_row = tk.Frame(af, bg="#f0f0f0")
        ic_row.pack(anchor="w", padx=18)
        tk.Checkbutton(ic_row, text="Include intercity in graph (--intercity)",
                       variable=self.do_ic, bg="#f0f0f0").pack(side=tk.LEFT)

        shapes_row = tk.Frame(af, bg="#f0f0f0")
        shapes_row.pack(anchor="w", fill=tk.X)
        tk.Checkbutton(shapes_row, bg="#f0f0f0",
            text="3. Rebuild shapes (generate_shapes.py)",
            variable=self.do_shapes).pack(side=tk.LEFT)
        tk.Checkbutton(shapes_row, bg="#f0f0f0", fg="#b45309",
            text="--force (overwrite even if TDX fails → fallback dots)",
            variable=self.do_force).pack(side=tk.LEFT, padx=14)

        self.run_btn = tk.Button(
            af, text="  Execute Selected  ",
            command=self._execute,
            bg="#1d4ed8", fg="white",
            font=("", 10, "bold"), padx=14, pady=5,
            relief=tk.FLAT, cursor="hand2",
        )
        self.run_btn.pack(anchor="e", pady=4)

        # Output
        of = tk.LabelFrame(bot, text="Output", padx=4, pady=4,
                            bg="#f0f0f0", font=("", 9, "bold"))
        of.pack(fill=tk.BOTH, expand=True, padx=4, pady=(2, 4))

        self.out = scrolledtext.ScrolledText(
            of, font=("Consolas", 9),
            bg="#1e1e1e", fg="#d4d4d4",
            insertbackground="white",
            wrap=tk.WORD,
        )
        self.out.pack(fill=tk.BOTH, expand=True)

        # Tag colours in output
        self.out.tag_config("ok",    foreground="#4ec94e")
        self.out.tag_config("warn",  foreground="#f5a623")
        self.out.tag_config("error", foreground="#f47272")
        self.out.tag_config("head",  foreground="#79b8ff", font=("Consolas", 9, "bold"))

    # ── Data loading ──────────────────────────────────────────────────────────

    def refresh(self):
        self._log("Refreshing status...\n", "head")
        self._status_lbl.config(text="Loading...")

        def _load():
            rows = [city_row(k, d, t) for k, d, t in ALL_CITIES]
            rows.append(_intercity_row())
            self.root.after(0, lambda: self._populate(rows))

        threading.Thread(target=_load, daemon=True).start()

    def _populate(self, rows: list[dict]):
        self.tree.delete(*self.tree.get_children())
        self._rows.clear()

        for r in rows:
            tag = r["shapes_tag"]
            row_tags = ["intercity"] if r["is_ic"] else [tag]
            iid = self.tree.insert("", tk.END,
                values=(r["display"], r["updated"], r["stops"], r["routes"],
                        r["sor"], r["shapes_txt"], r["graph"]),
                tags=row_tags)
            self._rows[iid] = r

        self._status_lbl.config(text=f"{len(rows)-1} cities + intercity loaded")
        self._log("Done.\n", "ok")

    # ── Selection helpers ─────────────────────────────────────────────────────

    def _on_select(self, _evt=None):
        n = len(self.tree.selection())
        self._status_lbl.config(text=f"{n} row(s) selected")

    def _sel_fallback(self):
        self.tree.selection_set()
        for iid, r in self._rows.items():
            if r["shapes_tag"] in ("fallback", "mixed", "missing") and not r["is_ic"]:
                self.tree.selection_add(iid)
        self._on_select()

    def _sel_all(self):
        self.tree.selection_set(list(self._rows.keys()))
        self._on_select()

    def _sel_clear(self):
        self.tree.selection_set()
        self._on_select()

    # ── Execution ─────────────────────────────────────────────────────────────

    def _execute(self):
        if self._running:
            messagebox.showwarning("Busy", "A pipeline is already running.")
            return

        sel_iids = self.tree.selection()
        if not sel_iids:
            messagebox.showwarning("Nothing selected",
                                   "Select at least one row in the table.")
            return
        if not any([self.do_fetch.get(), self.do_graph.get(), self.do_shapes.get()]):
            messagebox.showwarning("No action",
                                   "Check at least one action to perform.")
            return

        sel_rows = [self._rows[iid] for iid in sel_iids]
        self._running = True
        self.run_btn.config(state=tk.DISABLED, text="  Running...  ")

        q: queue.Queue = queue.Queue()

        force = self.do_force.get()

        def worker():
            for r in sel_rows:
                key, tdx, is_ic = r["key"], r["tdx"], r["is_ic"]
                q.put(("head", f"\n{'─'*50}\n  {r['display']}  ({tdx})\n{'─'*50}\n"))

                # 1. Fetch raw data (always overwrites)
                if self.do_fetch.get():
                    if is_ic:
                        _run([PYTHON, str(SCRIPT_DIR / "fetch_tdx.py"), "--intercity"], q)
                    else:
                        _run([PYTHON, str(SCRIPT_DIR / "fetch_tdx.py"), "--city", tdx], q)

                # 2. Rebuild graph
                if self.do_graph.get() and not is_ic:
                    cmd = [PYTHON, str(SCRIPT_DIR / "build_graph.py"), "--city", tdx]
                    if self.do_ic.get():
                        cmd.append("--intercity")
                    _run(cmd, q)

                # 3. Rebuild shapes
                if self.do_shapes.get():
                    if is_ic:
                        _run([PYTHON, str(SCRIPT_DIR / "generate_shapes.py"), "--intercity"], q)
                    else:
                        cmd = [PYTHON, str(SCRIPT_DIR / "generate_shapes.py"), "--city", tdx]
                        if force:
                            cmd.append("--force")
                        _run(cmd, q)

            q.put(("__done__", ""))

        threading.Thread(target=worker, daemon=True).start()
        self._drain(q)

    def _drain(self, q: queue.Queue):
        try:
            while True:
                tag, msg = q.get_nowait()
                if tag == "__done__":
                    self._running = False
                    self.run_btn.config(state=tk.NORMAL, text="  Execute Selected  ")
                    self._log("\n=== Pipeline finished ===\n", "ok")
                    self.refresh()
                    return
                self._log(msg, tag)
        except queue.Empty:
            pass
        self.root.after(40, lambda: self._drain(q))

    def _log(self, msg: str, tag: str = ""):
        self.out.insert(tk.END, msg, tag if tag else ())
        self.out.see(tk.END)


# ─── Subprocess runner ────────────────────────────────────────────────────────

def _run(cmd: list[str], q: queue.Queue):
    q.put(("warn", f"$ {' '.join(cmd)}\n"))
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(SCRIPT_DIR.parent),
        )
        for line in proc.stdout:
            # Colour-code TDX output keywords
            if any(w in line for w in ("[OK]", "Done", "完成")):
                q.put(("ok", line))
            elif any(w in line for w in ("[Error]", "失敗", "Traceback", "Error")):
                q.put(("error", line))
            elif any(w in line for w in ("[警告]", "[!]", "警告", "429", "fallback", "Fallback")):
                q.put(("warn", line))
            else:
                q.put(("", line))
        proc.wait()
        rc = proc.returncode
        if rc != 0:
            q.put(("error", f"[Exit {rc}]\n"))
    except Exception as e:
        q.put(("error", f"[Exception: {e}]\n"))


# ─── Entry point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    root = tk.Tk()
    App(root)
    root.mainloop()
