export const JOB_TEARDOWN = Symbol('JOB_TEARDOWN');

export interface JobTeardownPort {
  deleteJobDeep(jobId: string, orgId: string): Promise<void>;
}
