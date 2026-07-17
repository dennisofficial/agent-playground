import type { Agent } from './agent';
import type { PromptCtx } from './prompt-ctx';

export function FragmentGroup(): ClassDecorator {
  return () => undefined;
}

export type FragmentRender = (ctx: PromptCtx) => string;

export interface FragmentMeta {
  usedBy: Agent[];
  order: number;
  condition?: (ctx: PromptCtx) => boolean;
}

const FRAGMENT_META = new WeakMap<object, Record<string, FragmentMeta>>();

export function Fragment(meta: FragmentMeta): MethodDecorator {
  return (target, propertyKey) => {
    const existing = FRAGMENT_META.get(target) ?? {};
    existing[propertyKey as string] = meta;
    FRAGMENT_META.set(target, existing);
  };
}

export function getFragmentMetaMap(proto: object): Record<string, FragmentMeta> {
  return FRAGMENT_META.get(proto) ?? {};
}

export interface LoadedFragment {
  id: string;
  meta: FragmentMeta;
  render: FragmentRender;
}
