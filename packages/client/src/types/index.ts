export interface Workflow {
  id: string;
  name: string;
  rawJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowParam {
  id: number;
  workflowId: string;
  nodeId: string;
  fieldName: string;
  alias: string;
  label: string | null;
  paramType: string;
}

export interface WorkflowDetail extends Workflow {
  params: WorkflowParam[];
}

export interface Settings {
  [key: string]: string;
}
