import type { AnimationDocument, AnimationNode, Transform } from "@mcp-video-studio/contracts";
import { ease, mix } from "./easing.js";

export interface EvaluatedAnimationNode extends AnimationNode {
  visible: boolean;
}

function blendTransform(current: Transform, target: Partial<Transform>, progress: number): Transform {
  const position = target.position ?? current.position;
  const scale = target.scale ?? current.scale;
  const anchor = target.anchor ?? current.anchor;
  return {
    position: [mix(current.position[0], position[0], progress), mix(current.position[1], position[1], progress)],
    scale: [mix(current.scale[0], scale[0], progress), mix(current.scale[1], scale[1], progress)],
    rotation: mix(current.rotation, target.rotation ?? current.rotation, progress),
    anchor: [mix(current.anchor[0], anchor[0], progress), mix(current.anchor[1], anchor[1], progress)],
    opacity: mix(current.opacity, target.opacity ?? current.opacity, progress)
  };
}

export function evaluateAnimation(document: AnimationDocument, tick: number): EvaluatedAnimationNode[] {
  const states = new Map(document.nodes.map((node) => [node.id, { ...structuredClone(node), visible: true }]));
  const operations = [...document.operations].sort((a, b) => a.startTick - b.startTick || a.id.localeCompare(b.id));
  for (const operation of operations) {
    const state = states.get(operation.targetId);
    if (!state) continue;
    const raw = operation.durationTick === 0 ? (tick >= operation.startTick ? 1 : 0) : (tick - operation.startTick) / operation.durationTick;
    const progress = ease(operation.easing, raw);
    if (operation.type === "create" || operation.type === "write") {
      state.visible = tick >= operation.startTick;
      state.transform.opacity = mix(0, Number(operation.parameters.opacity ?? 1), progress);
      state.properties.reveal = progress;
    } else if (operation.type === "fade") {
      state.transform.opacity = mix(Number(operation.parameters.from ?? state.transform.opacity), Number(operation.parameters.to ?? 0), progress);
    } else if (operation.type === "transform") {
      state.transform = blendTransform(state.transform, operation.parameters.to as Partial<Transform> | undefined ?? {}, progress);
    } else if (operation.type === "rotate") {
      state.transform.rotation = mix(state.transform.rotation, Number(operation.parameters.to ?? state.transform.rotation), progress);
    } else if (operation.type === "scale") {
      const to = operation.parameters.to;
      const target: [number, number] = Array.isArray(to) && to.length >= 2 ? [Number(to[0]), Number(to[1])] : [Number(to ?? 1), Number(to ?? 1)];
      state.transform.scale = [mix(state.transform.scale[0], target[0], progress), mix(state.transform.scale[1], target[1], progress)];
    } else if (operation.type === "moveAlongPath") {
      const points = operation.parameters.points;
      if (Array.isArray(points) && points.length >= 2) {
        const segments = points as Array<[number, number]>;
        const scaled = Math.min(segments.length - 1, progress * (segments.length - 1));
        const index = Math.min(segments.length - 2, Math.floor(scaled));
        const local = scaled - index;
        const from = segments[index]!;
        const to = segments[index + 1]!;
        state.transform.position = [mix(from[0], to[0], local), mix(from[1], to[1], local)];
      }
    }
  }
  return [...states.values()];
}
