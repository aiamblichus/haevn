// The search worker's tests again, on a plain-Map index. They pass here only if the worker
// depends on the `SearchIndex` contract and on nothing that SQLite adds (HVN-87).
import "./helpers/useMapIndex";
import "./searchWorkerSuite";
