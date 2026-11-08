import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ installation: vi.fn(), project: vi.fn(), permissions: vi.fn(), roots: vi.fn(), search: vi.fn(), navigation: vi.fn(), read: vi.fn(), original: vi.fn() }));
vi.mock("@/library/server-resource-access", () => ({ installationForLibraryResource: mocks.installation }));
vi.mock("@/workbench/shared-access", () => ({ resolveProjectAccess: mocks.project }));
vi.mock("@/runtime/permission-turn", () => ({ resolveServerTurnPermissions: mocks.permissions }));
vi.mock("./enterprise-document-network", () => ({ EnterpriseDocumentNetwork: class { rootsForTurn = mocks.roots; } }));
vi.mock("./server-files", () => ({ ServerDocumentFiles: class { search = mocks.search; navigation = mocks.navigation; read = mocks.read; readOriginal = mocks.original; } }));
import { browseServerForSession } from "./server-browser-service";
const session = { provider: "local" as const, user: { id: "user", email: "qa@example.test", name: "QA" }, tenant: { id: "arnall", name: "Arnall" }, expiresAt: "2099-01-01T00:00:00Z" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.installation.mockResolvedValue({ installationId: "arnall" });
  mocks.project.mockResolvedValue({}); mocks.permissions.mockResolvedValue({}); mocks.roots.mockResolvedValue([]);
});
it("resolves project access before any source request and rejects tenant/project failures", async () => {
  mocks.installation.mockRejectedValueOnce(new Error("tenant denied"));
  await expect(browseServerForSession(session, "foreign", "server:/")).rejects.toThrow();
  expect(mocks.project).not.toHaveBeenCalled();
  mocks.project.mockRejectedValueOnce(new Error("project denied"));
  await expect(browseServerForSession(session, "foreign", "server:/")).rejects.toThrow();
  expect(mocks.permissions).not.toHaveBeenCalled(); expect(mocks.search).not.toHaveBeenCalled();
});
it("uses only fresh browsing and returns reference metadata without raw Windows paths", async () => {
  mocks.search.mockResolvedValue({ available: true, sourceChecked: true, results: [{ path: "server-arnall/Y/QA%20file.txt", source: "Y:\\QA file.txt", kind: "file", modifiedAt: null, size: 4 }] });
  const result = await browseServerForSession(session, "project", "server:/Y/");
  expect(mocks.search).toHaveBeenCalledWith([], "server:/Y/", 50, true);
  expect(result).toMatchObject({ results: [{ name: "QA file.txt" }] });
  expect(JSON.stringify(result)).not.toContain("Y:\\");
});

it("home checks membership and permissions but never starts a live source request", async () => {
  mocks.navigation.mockResolvedValue({ available: true, navigation: true, sourceChecked: false, results: [] });
  await expect(browseServerForSession(session, "project", "home")).resolves.toMatchObject({ navigation: true, sourceChecked: false });
  expect(mocks.project).toHaveBeenCalledWith(session, "project");
  expect(mocks.permissions).toHaveBeenCalledOnce();
  expect(mocks.navigation).toHaveBeenCalledWith([]);
  expect(mocks.search).not.toHaveBeenCalled();
});

it("preview denies project access before reading and rechecks it after the source read", async () => {
  const { previewServerForSession } = await import('./server-browser-service');
  mocks.project.mockRejectedValueOnce(Error('denied'));
  await expect(previewServerForSession(session,'project','server-g03/M/G03/a.txt')).rejects.toThrow('denied');
  expect(mocks.read).not.toHaveBeenCalled();
  mocks.project.mockResolvedValueOnce({}).mockRejectedValueOnce(Error('revoked'));
  mocks.read.mockResolvedValue({available:true,sourceChecked:true,content:'authorized before revocation'});
  await expect(previewServerForSession(session,'project','server-g03/M/G03/a.txt')).rejects.toThrow('revoked');
});
it("preview rejects stale evidence and never forwards an external continuation", async () => {
  const { previewServerForSession } = await import('./server-browser-service');
  mocks.read.mockResolvedValueOnce({available:true,sourceChecked:false,content:'stale'});
  expect(await previewServerForSession(session,'project','server-g03/M/G03/a.txt')).toEqual({available:false,error:'READ_UNAVAILABLE'});
  mocks.read.mockResolvedValueOnce({available:true,sourceChecked:true,content:'<script>data</script>',nextPath:'https://foreign.test',preview:{kind:'html',html:'unsafe'}});
  expect(await previewServerForSession(session,'project','server-g03/M/G03/a.txt')).toMatchObject({content:'<script>data</script>',nextPath:null,preview:null});
});

it("preserves a same-file, version-bound continuation and rejects malformed variants", async () => {
  const { previewServerForSession } = await import('./server-browser-service');
  const source='server-g03/M/G03/book.xlsm';
  const next=source+'?part=2&sha256='+'a'.repeat(64);
  mocks.read.mockResolvedValueOnce({available:true,sourceChecked:true,content:'first',nextPath:next,truncated:true,coverage:{documentCompleteInResponse:false,versionBound:true,secret:'omit'}});
  expect(await previewServerForSession(session,'project',source)).toMatchObject({nextPath:next,truncated:true,coverage:{documentCompleteInResponse:false,versionBound:true}});
  mocks.read.mockResolvedValueOnce({available:true,sourceChecked:true,content:'first',nextPath:next+'&other=1'});
  expect(await previewServerForSession(session,'project',source)).toMatchObject({nextPath:null});
});

it.each([
  ['SERVER_FORMAT_NOT_READABLE', 'SERVER_FORMAT_NOT_READABLE'],
  ['SERVER_REQUEST_DENIED', 'UNSUPPORTED_OR_DENIED'],
  ['upstream failure at C:\\private\\document with secret', 'READ_UNAVAILABLE'],
])("preview classifies %s without exposing upstream diagnostics", async (upstream, expected) => {
  const { previewServerForSession } = await import('./server-browser-service');
  mocks.read.mockResolvedValueOnce({ available: false, error: upstream });
  expect(await previewServerForSession(session, 'project', 'server-g03/M/G03/a.pptx'))
    .toEqual({ available: false, error: expected });
  expect(mocks.project).toHaveBeenCalledTimes(2);
});
