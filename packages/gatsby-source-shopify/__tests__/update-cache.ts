import { updateCache } from "../src/update-cache";
import * as eventsModule from "../src/events";
import {
  mockGatsbyApi,
  mockPluginOptions,
  mockShopifyEvents,
} from "./fixtures";

const gatsbyApi = mockGatsbyApi();
const pluginOptions = mockPluginOptions();

jest.mock("fetch");

const eventsApi = jest.spyOn(eventsModule, "eventsApi");

describe("updateCache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("successfully runs without delete events", async () => {
    eventsApi.mockReturnValue({ fetchDestroyEventsSince: async () => [] });

    // @ts-ignore
    await updateCache(gatsbyApi, pluginOptions, new Date(0));

    // @ts-ignore
    expect(gatsbyApi.actions.touchNode.mock.calls.length).toEqual(21);
    // @ts-ignore
    expect(gatsbyApi.actions.deleteNode.mock.calls.length).toEqual(0);
  });

  it("successfully runs with delete events", async () => {
    eventsApi.mockReturnValue({
      fetchDestroyEventsSince: async () => mockShopifyEvents("destroy"),
    });

    // @ts-ignore
    await updateCache(gatsbyApi, pluginOptions, new Date(0));

    // @ts-ignore
    expect(gatsbyApi.actions.touchNode.mock.calls.length).toEqual(11);
    // @ts-ignore
    expect(gatsbyApi.actions.deleteNode.mock.calls.length).toEqual(10);
  });
});
