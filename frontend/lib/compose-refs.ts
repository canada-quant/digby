import * as React from "react";

/**
 * Ref-composition utilities (radix-ui pattern), vendored for components that
 * need to forward a ref while also observing the node locally (e.g. kanban).
 */

type PossibleRef<T> = React.Ref<T> | undefined;

function setRef<T>(ref: PossibleRef<T>, value: T) {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref !== null && ref !== undefined) {
    (ref as React.MutableRefObject<T | null>).current = value;
  }
}

function composeRefs<T>(...refs: PossibleRef<T>[]): React.RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      setRef(ref, node);
    }
  };
}

function useComposedRefs<T>(...refs: PossibleRef<T>[]): React.RefCallback<T> {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs array is the dep list by design
  return React.useCallback(composeRefs(...refs), refs);
}

export { composeRefs, useComposedRefs };
