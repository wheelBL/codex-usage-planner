// Keep disk-backed state transitions in order; a failed write must not poison
// the queue. Network reads stay outside the queue so settings remain usable.
export function createSerialQueue() {
  let tail = Promise.resolve();
  return operation => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
}
