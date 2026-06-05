export const ZORFIT_MARK_SVG = `<svg class="brand-mark" viewBox="0 0 64 72" fill="none" aria-hidden="true"><polygon points="8,6 52,6 20,36 54,36 12,68 36,40 16,40 48,8" fill="#C8F542"></polygon><circle cx="54" cy="36" r="4.5" fill="#FF5C1A"></circle></svg>`;

export const ZORFIT_BRAND = `${ZORFIT_MARK_SVG}<span class="wordmark">ZORFIT</span>`;

export const ZORFIT_FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap');`;

export const ZORFIT_THEME_CSS = `
		${ZORFIT_FONT_IMPORT}
		:root {
			color-scheme: dark;
			font-family: "DM Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			--bg: #0a0a0a;
			--panel: #121212;
			--panel-2: #181818;
			--line: #2c2c2c;
			--text: #f5f2ec;
			--muted: #aaa49a;
			--soft: #d8d2c8;
			--green: #c8f542;
			--green-strong: #a8d92a;
			--blue: #c8f542;
			--amber: #ff5c1a;
			--red: #ff784d;
			--ink: #0a0a0a;
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			color: var(--text);
			background:
				linear-gradient(90deg, rgba(245, 242, 236, 0.04) 1px, transparent 1px) 0 0 / 84px 84px,
				linear-gradient(180deg, rgba(245, 242, 236, 0.035) 1px, transparent 1px) 0 0 / 84px 84px,
				var(--bg);
		}
		a { color: inherit; text-decoration: none; }
		.brand {
			display: inline-flex;
			align-items: center;
			gap: 12px;
			font-weight: 850;
		}
		.brand-mark {
			width: 36px;
			height: 40px;
			flex: 0 0 auto;
			display: block;
		}
		.wordmark {
			font-family: "Bebas Neue", Impact, sans-serif;
			font-size: 32px;
			line-height: 0.9;
			letter-spacing: 3px;
		}
		.button, button {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			min-height: 42px;
			padding: 0 16px;
			border: 1px solid rgba(245, 242, 236, 0.16);
			border-radius: 8px;
			background: rgba(245, 242, 236, 0.05);
			color: var(--text);
			font: inherit;
			font-weight: 750;
			white-space: nowrap;
			cursor: pointer;
		}
		.button.primary, button.primary {
			border-color: var(--green);
			background: var(--green);
			color: var(--ink);
			box-shadow: 0 14px 34px rgba(200, 245, 66, 0.16);
		}
		.button.google {
			border-color: rgba(200, 245, 66, 0.32);
			background: rgba(200, 245, 66, 0.08);
		}
		.button.disabled, button:disabled {
			justify-content: center;
			color: var(--muted);
			cursor: not-allowed;
			opacity: 0.72;
			box-shadow: none;
		}
		h1, h2, h3 {
			font-family: "Bebas Neue", Impact, sans-serif;
			letter-spacing: 0;
		}
		.eyebrow {
			color: var(--green);
			font-family: "Space Mono", monospace;
			font-size: 0.76rem;
			font-weight: 700;
			letter-spacing: 0.14em;
			text-transform: uppercase;
		}
		.pill, .status, .count, code {
			font-family: "Space Mono", monospace;
		}
`;
