"""
CS 饰品市场监测 - 桌面应用入口
使用 pywebview (WebView2) 渲染本地 HTML/JS 前端
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import webview

# 定位资源目录：PyInstaller --onefile 解包到 sys._MEIPASS；开发期用 __file__ 邻近
def resource_path(*parts):
    base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, *parts)


def apply_external_data():
    """exe 同目录存在 data.js 时覆盖内嵌数据 —— 刷新行情无需重新打包"""
    base_dir = os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) \
        else os.path.dirname(os.path.abspath(__file__))
    ext_data = os.path.join(base_dir, 'data.js')
    if not os.path.isfile(ext_data) or os.path.getsize(ext_data) < 10000:
        return
    try:
        with open(ext_data, 'rb') as f:
            payload = f.read()
        with open(resource_path('app', 'data.js'), 'wb') as f:
            f.write(payload)
        print('using external data.js:', ext_data, flush=True)
    except Exception as e:
        print('external data override skipped:', e, flush=True)


def base_dir():
    return os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) \
        else os.path.dirname(os.path.abspath(__file__))


# ---------- 行情刷新服务（应用内手动/自动刷新） ----------
# 合规控制：手动刷新冷却 30 分钟；启动自动刷新仅在数据落后 2 小时以上；
# 爬虫内部固定 3.5s/请求并遵循 robots.txt；运行中拒绝重复触发。
REFRESH_COOLDOWN = 30 * 60
AUTO_STALE_SEC = 2 * 3600
_refresh_state = {'running': False, 'error': None, 'done': 0.0}
_refresh_lock = threading.Lock()


def home_dir():
    """刷新运行的数据目录：缓存/快照在此持久积累（跨刷新、跨重启）"""
    base = os.environ.get('LOCALAPPDATA') or os.environ.get('APPDATA') or base_dir()
    d = os.path.join(base, 'CSSkinMonitor')
    os.makedirs(os.path.join(d, 'cache'), exist_ok=True)
    return d


def data_mtime():
    p = os.path.join(base_dir(), 'data.js')
    return os.path.getmtime(p) if os.path.isfile(p) else 0.0


def _find_node():
    return shutil.which('node')


def _refresh_worker():
    _refresh_state['running'] = True
    _refresh_state['error'] = None
    try:
        node = _find_node()
        if not node:
            raise RuntimeError('未检测到 Node.js（应用内刷新需要）')
        env = dict(os.environ, CS_SKIN_HOME=home_dir())
        script = resource_path('crawler.js')
        # 应用内刷新走快速路径：跳过图片本地化（运行时 Steam CDN 兜底）
        # CREATE_NO_WINDOW：node 是控制台程序，不隐藏会每次刷新弹黑色 cmd 窗口
        flags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, 'CREATE_NO_WINDOW') else 0
        r = subprocess.run([node, script, '--offline-img', '0'], cwd=home_dir(), env=env, timeout=1500,
                           capture_output=True, text=True, encoding='utf-8', errors='replace',
                           creationflags=flags)
        if r.returncode != 0:
            raise RuntimeError((r.stdout or '')[-300:] + ' | ' + (r.stderr or '')[-200:])
        src = os.path.join(home_dir(), 'app', 'data.js')
        if os.path.isfile(src):
            shutil.copyfile(src, os.path.join(base_dir(), 'data.js'))
        _refresh_state['done'] = time.time()
    except Exception as e:
        _refresh_state['error'] = str(e)
    finally:
        _refresh_state['running'] = False


class JsApi:
    """JS 桥：收藏持久化。WebView2 对 file:// 来源的 localStorage 不可靠，
    收藏统一落盘 exe 同目录 favorites.json，随用户自由备份。"""

    def fav_path(self):
        return os.path.join(base_dir(), 'favorites.json')

    def load_favorites(self):
        try:
            with open(self.fav_path(), 'r', encoding='utf-8') as f:
                return f.read()
        except Exception:
            return ''

    def save_favorites(self, data):
        try:
            obj = json.loads(data) if isinstance(data, str) else data
            if not isinstance(obj, dict):
                return 'skip'
            with open(self.fav_path(), 'w', encoding='utf-8') as f:
                json.dump(obj, f, ensure_ascii=False)
            return 'ok'
        except Exception as e:
            print('save favorites failed:', e, flush=True)
            return 'error'

    def refresh_status(self):
        mt = data_mtime()
        age = int(time.time() - mt) if mt else -1
        return json.dumps({
            'running': _refresh_state['running'],
            'error': _refresh_state['error'],
            'lastDone': _refresh_state['done'],
            'dataAgeSec': age,
            'cooldownLeft': max(0, int(REFRESH_COOLDOWN - age)) if mt else 0,
            'autoStaleSec': AUTO_STALE_SEC,
        }, ensure_ascii=False)

    def start_refresh(self):
        with _refresh_lock:
            if _refresh_state['running']:
                return json.dumps({'ok': False, 'reason': 'running'})
            mt = data_mtime()
            if mt and time.time() - mt < REFRESH_COOLDOWN:
                return json.dumps({'ok': False, 'reason': 'cooldown',
                                   'left': int(REFRESH_COOLDOWN - (time.time() - mt))})
            if not _find_node():
                return json.dumps({'ok': False, 'reason': 'node_missing'})
            threading.Thread(target=_refresh_worker, daemon=True).start()
            return json.dumps({'ok': True})


def main():
    apply_external_data()
    html_path = resource_path('app', 'index.html')
    url = 'file:///' + html_path.replace('\\', '/')
    # 可选启动路由：CSSkinMonitor.exe "#/detail/1"
    if len(sys.argv) > 1 and sys.argv[1].startswith('#'):
        url += sys.argv[1]

    window = webview.create_window(
        title='CS 饰品市场监测 · 价格行情雷达',
        url=url,
        width=1180,
        height=820,
        min_size=(760, 600),
        resizable=True,
        background_color='#0e141b',
        text_select=True,
        js_api=JsApi()
    )

    # F12 开启开发者工具（仅 Windows WebView2 生效）
    def open_devtools():
        try:
            window.evaluate_js('void 0')  # noop，确保 context 就绪
            window.evaluate_js(
                'if(window.chrome&&window.chrome.webview){window.chrome.webview.hostObjects}void 0'
            )
        except Exception:
            pass

    # 启动 GUI，gui 留空（Windows 自动选 edgechromium）
    webview.start(debug=False, gui=None)


if __name__ == '__main__':
    main()
