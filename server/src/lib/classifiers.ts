import { execFileSync } from 'node:child_process';
import type { WorkflowConfig } from '../types.js';

function runPython(source: string, args: string[]) {
  const out = execFileSync('python3', ['-c', source, ...args], { encoding: 'utf8' });
  return JSON.parse(out);
}

export function classifyWorkflowJob(workflow: WorkflowConfig, jobPath: string) {
  if (workflow.classifyMode === 'implementation') {
    return runPython(
      `
import json, sys
from pathlib import Path
base = Path('/Users/jonsnow/.openclaw/workspace-implementation/automation/implementation-jira/scripts')
sys.path.insert(0, str(base))
import workflow_state
job = json.loads(Path(sys.argv[1]).read_text())
print(json.dumps(workflow_state.compute_state(job)))
      `.trim(),
      [jobPath]
    );
  }

  if (workflow.classifyMode === 'tech-plan') {
    return runPython(
      `
import json, sys
from pathlib import Path
base = Path('/Users/jonsnow/.openclaw/workspace-tech-plan/automation/tech-plan-jira/scripts')
sys.path.insert(0, str(base))
import classify_job
print(json.dumps(classify_job.classify(Path(sys.argv[1]))))
      `.trim(),
      [jobPath]
    );
  }

  return runPython(
    `
import json, sys
from pathlib import Path
base = Path('/Users/jonsnow/.openclaw/workspace-concept-lab/automation/concept-lab/scripts')
sys.path.insert(0, str(base))
import workflow_state
job = json.loads(Path(sys.argv[1]).read_text())
print(json.dumps(workflow_state.compute_state(job)))
    `.trim(),
    [jobPath]
  );
}
