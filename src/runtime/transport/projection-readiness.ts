import { BackgroundModelAdmissionDeferred } from "@/runtime/model-turn-queue";

/** Admission only: no new provider turn has been submitted. The hot client
 * must remain alive so ordered durable recovery can finish between sweeps. */
export class RuntimeProjectionAdmissionDeferred extends BackgroundModelAdmissionDeferred {
  constructor() {
    super();
    this.name = "RuntimeProjectionAdmissionDeferred";
    this.message = "RUNTIME_PROJECTION_ADMISSION_DEFERRED";
  }
}
