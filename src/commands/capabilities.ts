import { version as engineVersion } from "@rex0220/kintone-sql-tools/flow";
import { EXECUTION_CONTRACT, EXECUTION_RESULT_SCHEMA_ID } from "../contract";
import { RUNNER_VERSION } from "../executor";
import { EXIT, type ExitCode } from "../types";
import { writeJsonObject } from "./machineJson";

export function capabilitiesCommand(): ExitCode {
  writeJsonObject({
    formatVersion: 1,
    kind: "CAPABILITIES",
    ksqlFlowVersion: RUNNER_VERSION,
    engineVersion,
    executionContracts: [EXECUTION_CONTRACT],
    resultSchema: {
      $id: EXECUTION_RESULT_SCHEMA_ID,
      contract: EXECUTION_CONTRACT,
    },
    features: {
      resultJson: true,
      correlationIds: true,
      describeProfile: true,
      inspectJob: true,
      durableExecutionStarted: true,
      gracefulCancel: false,
      jobLockProtocol: "profile-job-v0",
    },
  });
  return EXIT.OK;
}
