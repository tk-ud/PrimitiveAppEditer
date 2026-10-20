"""Playwright (CDP attach) driver and UI Marker resolver (GUI Debug Tool.md §6 / §8).

Locators: part / view / status -> DOM id, marker -> data-pae-marker, role -> ARIA role + accessible name,
css -> justified selector. No image recognition, no coordinates, no positional selection of ambiguous candidates.
`item.identity` matches the target element's `data-pae-item` exactly; `item.text` matches the normalized text exactly.
"""

from __future__ import annotations

from typing import Any

from .expectations import normalize_text
from .runner import ConnectionLost, DriverError

_CONNECTION_HINTS = ("Target closed", "Target page, context or browser has been closed", "Connection closed", "has been disconnected", "Browser has been closed")


def _css_attr(value: str) -> str:
	return value.replace("\\", "\\\\").replace('"', '\\"')


class PlaywrightDriver:
	def __init__(self, host: str = "127.0.0.1", port: int = 9222):
		if host not in ("127.0.0.1", "localhost", "::1"):
			raise ValueError("CDP endpoint must be bound to localhost (GUI Debug Tool.md §6)")
		self.host, self.port = host, port
		self._pw = None
		self._browser = None
		self.page = None
		self.window_filter: str | None = None

	# ---- connection ----
	def connect(self, window: str | None = None) -> None:
		from playwright.sync_api import sync_playwright  # lazy: GUI-independent parts need no Playwright
		try:
			self._pw = sync_playwright().start()
			self._browser = self._pw.chromium.connect_over_cdp(f"http://{self.host}:{self.port}")
		except Exception as e:
			self.disconnect()
			raise ConnectionLost(f"CDP connect failed on {self.host}:{self.port}: {e}") from e
		self.window_filter = window
		self.select_window(window)

	def disconnect(self) -> None:
		for closer in (lambda: self._browser and self._browser.close(), lambda: self._pw and self._pw.stop()):
			try:
				closer()
			except Exception:
				pass
		self._pw = self._browser = self.page = None

	def workbench_pages(self) -> list[Any]:
		pages = [p for ctx in (self._browser.contexts if self._browser else []) for p in ctx.pages]
		return [p for p in pages if "workbench" in p.url and p.url.endswith((".html", ".html?")) or "workbench.html" in p.url]

	def select_window(self, window: str | None) -> Any:
		pages = self.workbench_pages()
		if window:
			pages = [p for p in pages if window in (p.title() or "") or window in p.url]
		self.page = pages[0] if len(pages) >= 1 else None
		if len(pages) > 1:
			self.page = None  # multiple windows: explicit selection required
		return self.page

	def check_window(self, window: str | None) -> str | None:
		try:
			if self._browser is None:
				raise ConnectionLost("not connected")
			pages = self.workbench_pages()
			if window:
				pages = [p for p in pages if window in (p.title() or "") or window in p.url]
			if not pages:
				return f"no Workbench window matching '{window or 'workbench.html'}'"
			if len(pages) > 1:
				return f"{len(pages)} Workbench windows match; select the target window explicitly"
			self.page = pages[0]
			return None
		except ConnectionLost:
			raise
		except Exception as e:
			self._raise(e)

	def _raise(self, e: Exception):
		if any(h in str(e) for h in _CONNECTION_HINTS):
			raise ConnectionLost(str(e)) from e
		raise DriverError(str(e)) from e

	# ---- resolution ----
	def _locator(self, chain: list[dict], item: dict | None):
		loc: Any = self.page
		for part in chain:
			kind, value = part["kind"], part["value"]
			if kind in ("part", "view", "status"):
				loc = loc.locator(f'[id="{_css_attr(value)}"]')
			elif kind == "marker":
				loc = loc.locator(f'[data-pae-marker="{_css_attr(value)}"]')
			elif kind == "role":
				role, _, name = value.partition(":")
				loc = loc.get_by_role(role.strip(), name=name.strip(), exact=True)
			else:
				loc = loc.locator(value)
		if item and item.get("identity"):
			loc = loc.and_(self.page.locator(f'[data-pae-item="{_css_attr(item["identity"])}"]'))
		return loc

	def _matches(self, chain: list[dict], item: dict | None) -> tuple[Any, list[int]]:
		if self.page is None:
			raise ConnectionLost("no Workbench page selected")
		try:
			loc = self._locator(chain, item)
			text = item.get("text") if item else None
			if text is None:
				return loc, list(range(loc.count()))
			want = normalize_text(text)
			texts = loc.evaluate_all("els => els.map(e => e.innerText || e.textContent || '')")
			return loc, [i for i, t in enumerate(texts) if normalize_text(t) == want]
		except (ConnectionLost, DriverError):
			raise
		except Exception as e:
			self._raise(e)

	def count(self, chain: list[dict], item: dict | None) -> int:
		return len(self._matches(chain, item)[1])

	def observe(self, chain: list[dict], item: dict | None) -> dict:
		loc, idx = self._matches(chain, item)
		if len(idx) != 1:
			raise DriverError(f"observe requires a unique match, got {len(idx)}")
		el = loc.nth(idx[0])  # idx[0] is the single resolved candidate, not a positional choice
		try:
			info = el.evaluate("""e => ({
				focused: document.activeElement === e || e.contains(document.activeElement),
				text: e.innerText || e.textContent || '',
				input_value: ('value' in e) ? String(e.value) : null,
				attributes: Object.fromEntries(Array.from(e.attributes).map(a => [a.name, a.value])),
			})""")
			info["visible"] = el.is_visible()
			info["enabled"] = el.is_enabled()
			return info
		except Exception as e:
			self._raise(e)

	def item_ids(self, chain: list[dict]) -> set[str]:
		loc = self._locator(chain, None)
		try:
			return {v for v in loc.evaluate_all("els => els.map(e => e.getAttribute('data-pae-item'))") if v}
		except Exception as e:
			self._raise(e)

	# ---- operation ----
	def perform(self, action: str, chain: list[dict] | None, item: dict | None, value: Any) -> None:
		try:
			if chain is not None:
				loc, idx = self._matches(chain, item)
				if len(idx) != 1:
					raise DriverError(f"{action} requires a unique target, got {len(idx)}")
				el = loc.nth(idx[0])
			if action == "click":
				el.click(timeout=5000)
			elif action == "double_click":
				el.dblclick(timeout=5000)
			elif action == "context_click":
				el.click(button="right", timeout=5000)
			elif action == "hover":
				el.hover(timeout=5000)
			elif action == "focus":
				el.focus(timeout=5000)
			elif action == "type":
				el.click(timeout=5000)
				el.press_sequentially(str(value))
			elif action == "select":
				el.select_option(label=str(value))
			elif action == "press":
				self.page.keyboard.press(str(value))
			elif action == "command":
				self.page.keyboard.press("F1")
				self.page.keyboard.type(str(value))
				self.page.keyboard.press("Enter")
			else:
				raise DriverError(f"unsupported action {action}")
		except (ConnectionLost, DriverError):
			raise
		except Exception as e:
			self._raise(e)

	def screenshot(self, path: str) -> None:
		if self.page is None:
			raise DriverError("no page for screenshot")
		self.page.screenshot(path=path)
