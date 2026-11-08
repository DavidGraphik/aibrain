import {expect,it} from "vitest";
import {BackgroundModelAdmissionDeferred} from "@/runtime/model-turn-queue";
import {hostAnalysisFailure} from "./failure";

it("preserves only fixed capacity/expiry classifications and never exposes raw errors",()=>{
  expect(hostAnalysisFailure(new BackgroundModelAdmissionDeferred())).toEqual({code:"HOST_ANALYSIS_CAPACITY_DEFERRED",exitCode:75});
  expect(hostAnalysisFailure(Error("HOST_QUEUE_TIMEOUT"))).toEqual({code:"HOST_QUEUE_TIMEOUT",exitCode:76});
  expect(hostAnalysisFailure(Error("HOST_TERMINAL_TIMEOUT"))).toEqual({code:"HOST_TERMINAL_TIMEOUT",exitCode:77});
  for(const value of [Error("private provider error"),Error("HOST_REQUEST_DENIED"),"HOST_QUEUE_TIMEOUT",{message:"HOST_QUEUE_TIMEOUT"}]) {
    expect(hostAnalysisFailure(value)).toEqual({code:"HOST_ANALYSIS_UNAVAILABLE",exitCode:1});
  }
});
