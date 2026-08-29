"""
CS 饰品市场监测 - 桌面应用入口
使用 pywebview (WebView2) 渲染本地 HTML/JS 前端
"""
import json
import os
import shutil
import sys
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
