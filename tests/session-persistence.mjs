// The JSONL session backend changed from a default-exported plugin class (before 0.2.1-rc.3) to a function-form
// module exporting `name` and `apply` (0.2.1-rc.3). Cordis mounts either shape through `ctx.plugin`, so the tests
// normalize whichever host checkout is linked.
import * as backend from '@deepseek-ai/dsh-session-persistence-jsonl';

const Persistence = backend.default ?? { name: backend.name, apply: backend.apply };

export default Persistence;
