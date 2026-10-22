import { call, media, type Annotation, type Capture } from "./api";

const ns = "http://www.w3.org/2000/svg";
function shape(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

export function annotationElements(items: Annotation[], width: number, height: number, selected: number | null = null): SVGElement[] {
  let number = 0;
  const sx = 1000 / Math.max(1, width), sy = 680 / Math.max(1, height);
  return items.map(item => {
    const attrs = { fill: "none", stroke: item.color, "stroke-width": 2.5, "stroke-linecap": "round", "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke", "pointer-events": "none" };
    if (item.type === "pin") {
      number++;
      const group = shape("g", { class: `annotation-pin${selected === item.id ? " selected" : ""}`, "data-pin": item.id, role: "button", tabindex: 0, "aria-label": `Note ${number}: ${item.text || "New note"}` });
      group.append(shape("ellipse", { cx: item.x, cy: item.y, rx: 14 * sx, ry: 14 * sy, fill: item.color, stroke: "#f8fafc", "stroke-width": 1.2, "vector-effect": "non-scaling-stroke" }));
      const text = shape("text", { x: item.x, y: item.y, dy: ".35em", "text-anchor": "middle", fill: "#f8fafc", "font-size": 12, "font-family": "Segoe UI, sans-serif", "font-weight": 600, transform: `translate(${item.x} ${item.y}) scale(${sx} ${sy}) translate(${-item.x} ${-item.y})` });
      text.textContent = String(number); group.append(text); return group;
    }
    if (item.type === "pen") return shape("polyline", { ...attrs, points: item.points.map(p => p.join(",")).join(" ") });
    if (item.type === "rectangle") return shape("rect", { ...attrs, x: Math.min(item.x, item.x2), y: Math.min(item.y, item.y2), width: Math.abs(item.x2 - item.x), height: Math.abs(item.y2 - item.y), rx: 3 });
    if (item.type === "ellipse") return shape("ellipse", { ...attrs, cx: (item.x + item.x2) / 2, cy: (item.y + item.y2) / 2, rx: Math.abs(item.x2 - item.x) / 2, ry: Math.abs(item.y2 - item.y) / 2 });
    const group = shape("g", { "pointer-events": "none" });
    const angle = Math.atan2((item.y2 - item.y) / sy, (item.x2 - item.x) / sx);
    group.append(shape("line", { ...attrs, x1: item.x, y1: item.y, x2: item.x2, y2: item.y2 }));
    group.append(shape("polyline", { ...attrs, points: `${item.x2 - 12 * sx * Math.cos(angle - .55)},${item.y2 - 12 * sy * Math.sin(angle - .55)} ${item.x2},${item.y2} ${item.x2 - 12 * sx * Math.cos(angle + .55)},${item.y2 - 12 * sy * Math.sin(angle + .55)}` }));
    return group;
  });
}

export async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image(); image.crossOrigin = "anonymous"; image.src = src;
  await image.decode(); return image;
}

export async function persistAnnotations(capture: Capture, items: Annotation[]): Promise<void> {
  const original = await loadImage(media(capture.originalPath));
  const canvas = document.createElement("canvas"); canvas.width = capture.width; canvas.height = capture.height;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Could not prepare the annotated screenshot. Try again.");
  ctx.drawImage(original, 0, 0);
  const svg = shape("svg", { xmlns: ns, viewBox: "0 0 1000 680", width: capture.width, height: capture.height, preserveAspectRatio: "none" });
  const radiusScale = Math.max(.75, Math.min(capture.width, capture.height) / 680);
  svg.append(...annotationElements(items, capture.width / radiusScale, capture.height / radiusScale));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
  try { ctx.drawImage(await loadImage(url), 0, 0); }
  finally { URL.revokeObjectURL(url); }
  await call("save_annotations", { id: capture.id, items, image: canvas.toDataURL("image/png").split(",")[1] });
}
