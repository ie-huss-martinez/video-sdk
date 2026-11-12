import { describeVideoEngineContract } from "../contracts/video-engine.contract.js";
import { describeVideoOutputContract } from "../contracts/video-output.contract.js";
import { describeVideoProcessorContract } from "../contracts/video-processor.contract.js";
import { fakeEngineHarness, fakeOutputHarness, fakeProcessorHarness } from "./harness.js";

// The fakes pass the same suites as the real adapters will, which also
// proves the suites themselves. The session's tests will run against them.
describeVideoEngineContract("fake engine", fakeEngineHarness);
describeVideoProcessorContract("fake processor", fakeProcessorHarness);
describeVideoOutputContract("fake output", fakeOutputHarness);
