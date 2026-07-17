export interface BranchControlLabels {
  group: string;
  status: string;
  previous: string;
  next: string;
  tree: string;
}

export function branchControlLabels(
  role: "user" | "assistant",
  messagePosition: number,
  branchIndex: number,
  branchTotal: number,
): BranchControlLabels {
  const owner = `${role} message ${messagePosition}`;
  return {
    group: `Branch navigation for ${owner}`,
    status: `Branch position for ${owner}: ${branchIndex} of ${branchTotal}`,
    previous: `Previous branch for ${owner}`,
    next: `Next branch for ${owner}`,
    tree: `View conversation tree from ${owner}`,
  };
}
