export const GRAPH_END = '__end__';
const DEFAULT_GRAPH_END = GRAPH_END;

function mergeGraphState(currentState, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return currentState;
  }

  const {
    graphTrace: _ignoredGraphTrace,
    next: _ignoredNext,
    ...safePatch
  } = patch;

  return {
    ...currentState,
    ...safePatch,
  };
}

export function createStateGraph({ start, end = DEFAULT_GRAPH_END, nodes }) {
  if (!start || typeof start !== 'string') {
    throw new Error('State graph needs a start node.');
  }

  if (!nodes || typeof nodes !== 'object') {
    throw new Error('State graph needs a node map.');
  }

  return {
    start,
    end,
    nodes,
  };
}

export async function runStateGraph(graph, initialState = {}, options = {}) {
  if (!graph || typeof graph !== 'object') {
    throw new Error('Cannot run an empty state graph.');
  }

  const { maxSteps = 64, onStep } = options || {};
  let state = {
    ...initialState,
    graphTrace: Array.isArray(initialState.graphTrace)
      ? [...initialState.graphTrace]
      : [],
  };
  let currentNode = graph.start;
  let stepCount = 0;

  while (currentNode && currentNode !== graph.end) {
    if (stepCount >= maxSteps) {
      throw new Error(
        `State graph exceeded maxSteps=${maxSteps}. Trace: ${state.graphTrace
          .slice(-10)
          .join(' -> ')}`,
      );
    }

    const nextTrace = [...state.graphTrace, currentNode];
    const handler = graph.nodes?.[currentNode];
    if (typeof handler !== 'function') {
      throw new Error(
        `State graph node "${currentNode}" is not defined. Trace: ${nextTrace.join(' -> ')}`,
      );
    }

    const stateForNode = {
      ...state,
      graphTrace: nextTrace,
    };
    const nodeStartedAt = Date.now();
    let result;
    try {
      result = await handler(stateForNode);
    } catch (error) {
      if (error && typeof error === 'object') {
        error.graphTrace = [...nextTrace];
        error.graphFailedNode = currentNode;
      }
      throw error;
    }

    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error(
        `State graph node "${currentNode}" returned an invalid result. Trace: ${nextTrace.join(
          ' -> ',
        )}`,
      );
    }

    const elapsedMs = Date.now() - nodeStartedAt;
    const nextNode =
      typeof result.next === 'string' ? result.next : graph.end;
    const patch = Object.fromEntries(
      Object.entries(result).filter(([key]) => key !== 'next'),
    );

    state = mergeGraphState(stateForNode, patch);
    stepCount += 1;

    if (typeof onStep === 'function') {
      try {
        await onStep({
          node: currentNode,
          state,
          result,
          stepCount,
          elapsedMs,
          nextNode,
        });
      } catch {}
    }

    if (process.env.MELO_GRAPH_DEBUG === '1') {
      process.stdout.write(
        `[graph] step=${stepCount} node=${currentNode} elapsed=${elapsedMs}ms next=${nextNode}\n`,
      );
    }

    currentNode = nextNode;
  }

  return state;
}
