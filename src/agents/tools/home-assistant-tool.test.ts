import { describe, expect, it, vi } from "vitest";
import { createHomeAssistantTool } from "./home-assistant-tool.js";

const callGatewayTool = vi.fn(async (method: string, _opts: unknown, params: unknown) => ({
  method,
  params,
  ok: true,
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: (...args: unknown[]) => callGatewayTool(...args),
}));

describe("home_assistant tool", () => {
  it("maps intent turn-on text to ha.turnOn", async () => {
    callGatewayTool.mockClear();
    const tool = createHomeAssistantTool();

    const result = await tool.execute("call-1", {
      action: "intent",
      intent: "Turn on switch.office_plug",
    });

    expect(callGatewayTool).toHaveBeenCalledWith("ha.turnOn", expect.any(Object), {
      entityId: "switch.office_plug",
    });
    expect((result.details as { mapped?: { method?: string } }).mapped?.method).toBe("ha.turnOn");
  });

  it("maps intent list lights to ha.listStates with light domain", async () => {
    callGatewayTool.mockClear();
    const tool = createHomeAssistantTool();

    await tool.execute("call-2", {
      intent: "list all lights",
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "ha.listStates",
      expect.any(Object),
      expect.objectContaining({ domain: "light" }),
    );
  });

  it("maps explicit service intent to ha.callService and injects entity_id", async () => {
    callGatewayTool.mockClear();
    const tool = createHomeAssistantTool();

    await tool.execute("call-3", {
      action: "intent",
      intent: "Call service light.turn_on for light.kitchen",
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "ha.callService",
      expect.any(Object),
      expect.objectContaining({
        domain: "light",
        service: "turn_on",
        data: expect.objectContaining({ entity_id: "light.kitchen" }),
      }),
    );
  });

  it("supports explicit direct action", async () => {
    callGatewayTool.mockClear();
    const tool = createHomeAssistantTool();

    await tool.execute("call-4", {
      action: "get_state",
      entityId: "light.kitchen",
    });

    expect(callGatewayTool).toHaveBeenCalledWith("ha.getState", expect.any(Object), {
      entityId: "light.kitchen",
    });
  });

  it("errors when intent cannot be mapped", async () => {
    callGatewayTool.mockClear();
    const tool = createHomeAssistantTool();

    await expect(
      tool.execute("call-5", {
        action: "intent",
        intent: "do the thing",
      }),
    ).rejects.toThrow(/Could not map Home Assistant intent/i);
  });
});
