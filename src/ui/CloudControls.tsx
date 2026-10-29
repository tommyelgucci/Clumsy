import { useState } from 'react';
import type { CloudUser } from '../cloud/auth';
import type { Engine } from '../gl/engine';
import { Feed } from './Feed';
import { Overlay } from './Overlay';
import { FeedIcon, PublishIcon } from './icons';
import { PublishDialog } from './PublishDialog';

/** Publish and Feed buttons (phases 4-5). The editor only mounts this when
 *  the app has Firebase configuration, and loads it lazily, so an
 *  unconfigured (purely local) app never downloads the Firebase SDK. */
export default function CloudControls({ engine, user, cleanExport }: { engine: Engine; user: CloudUser | null; cleanExport: boolean }) {
  const [open, setOpen] = useState<'publish' | 'feed' | null>(null);
  return (
    <>
      <button className="cl-railbtn" onClick={() => setOpen('publish')} aria-label="Publish" title="Publish to the feed">
        <PublishIcon />
      </button>
      <button className="cl-railbtn" onClick={() => setOpen('feed')} aria-label="Feed" title="Feed">
        <FeedIcon />
      </button>
      <Overlay>
        {open === 'publish' && <PublishDialog engine={engine} user={user} cleanExport={cleanExport} onClose={() => setOpen(null)} />}
        {open === 'feed' && <Feed user={user} onClose={() => setOpen(null)} />}
      </Overlay>
    </>
  );
}
