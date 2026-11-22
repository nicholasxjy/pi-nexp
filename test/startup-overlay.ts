import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		let close: () => void;
		void ctx.ui.custom<void>((_tui, _theme, _keys, done) => {
			close = () => done(undefined);
			return { render: () => ["Startup overlay"], invalidate() {} };
		}, {
			overlay: true,
			overlayOptions: { nonCapturing: true },
			onHandle: (overlay) => {
				// Wait until both extensions have processed session_start.
				setTimeout(() => {
					overlay.focus();
					close();
					ctx.ui.notify("Startup overlay closed");
				}, 150);
			},
		});
	});
}
