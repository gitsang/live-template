<script lang="ts">
	/**
	 * 像素精灵：ASCII 点阵 → SVG。
	 * '#' = 强调色，'+' = 挖空（用面板底色填回），'.' = 透明。
	 * 想换图案直接改 SPRITES 里的字符画（每行等长即可）。
	 */
	export const SPRITES: Record<string, string[]> = {
		/* 8×8 老式显示器 */
		screen: [
			'........',
			'.######.',
			'.#....#.',
			'.#.##.#.',
			'.#....#.',
			'.######.',
			'...##...',
			'..####..'
		],
		/* 8×8 铃铛 */
		bell: [
			'........',
			'...##...',
			'..####..',
			'.######.',
			'.######.',
			'.######.',
			'########',
			'...##...'
		],
		/* 8×8 对话气泡 */
		bubble: [
			'........',
			'.######.',
			'########',
			'#......#',
			'#.####.#',
			'#......#',
			'########',
			'.##.....'
		],
		/* 8×8 礼物盒（含蝴蝶结与竖缎带） */
		gift: [
			'..####..',
			'.#.##.#.',
			'########',
			'##.##.##',
			'########',
			'###..###',
			'###..###',
			'########'
		],
		/* 8×8 四角星（醒目留言用） */
		star: [
			'...##...',
			'...##...',
			'..####..',
			'########',
			'########',
			'..####..',
			'...##...',
			'...##...'
		],
		/* 12×8 手柄 */
		pad: [
			'............',
			'..########..',
			'.##########.',
			'############',
			'#+##....##+#',
			'############',
			'.##########.',
			'..########..'
		]
	};

	interface Props {
		name: string;
		/** 挖空处使用的颜色，通常传面板底色 */
		cut?: string;
	}

	let { name, cut = '#151a2b' }: Props = $props();

	const rows = $derived(SPRITES[name] ?? []);
	const w = $derived(rows[0]?.length ?? 0);
	const h = $derived(rows.length);

	/** 每个 '#' / '+' 展开成一个 1×1 的 rect，保持像素锐利 */
	const rects = $derived.by(() => {
		const out: Array<{ x: number; y: number; fill?: string }> = [];
		for (let y = 0; y < rows.length; y++) {
			const row = rows[y];
			for (let x = 0; x < row.length; x++) {
				const c = row[x];
				if (c === '#') out.push({ x, y });
				else if (c === '+') out.push({ x, y, fill: cut });
			}
		}
		return out;
	});
</script>

{#if w > 0}
	<svg
		viewBox="0 0 {w} {h}"
		fill="currentColor"
		shape-rendering="crispEdges"
		preserveAspectRatio="xMidYMid meet"
		aria-hidden="true"
	>
		{#each rects as r}
			<rect x={r.x} y={r.y} width="1.06" height="1.06" fill={r.fill} />
		{/each}
	</svg>
{/if}
