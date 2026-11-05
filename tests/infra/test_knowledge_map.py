import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch

INFRA = Path(__file__).resolve().parents[2] / 'infra/hetzner'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, INFRA / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


mapping = load('mapping', 'knowledge-map.py')
catalogue = load('map_catalogue', 'knowledge-catalogue.py')
files = load('map_files_test', 'rdp-server-files.py')


class MapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.store = catalogue.Catalogue(self.root / 'operator', 'test', 'operator')
        self.addCleanup(self.store.close)
        self.manifest = {'installationId': 'test', 'connectionId': 'fictional', 'sourceRoots': ['Y:\\'],
                         'connectionConfig': 'fixture', 'accessManifest': 'fixture', 'publications': [{'scope': 'company', 'scopeId': None}]}
        self.access = {'readRoots': ['Y:\\']}
        config = patch.object(files.rdp, 'load_config', lambda *_: ({}, {}, self.access, self.root))
        config.start(); self.addCleanup(config.stop)
        self.scan = self.store.start_scan(['Y:\\'])
        self.store.record_page(self.scan, 'Y:\\', 0, [self.entry('Y:\\Ofertes', True), self.entry('Y:\\Secret', True)], None)
        self.store.record_page(self.scan, 'Y:\\Ofertes', 0,
                               [self.entry('Y:\\Ofertes\\Pressupost Àlpha.pdf'), self.entry('Y:\\Ofertes\\program.exe')], None)
        self.store.record_page(self.scan, 'Y:\\Secret', 0, [self.entry('Y:\\Secret\\private.txt')], None)
        self.target = self.root / 'map'
        self.build()

    def entry(self, source, directory=False):
        return {'source': source, 'directory': directory, 'bytes': 20, 'modifiedUtc': '2026-09-02T00:00:00Z'}

    def build(self):
        binding, allowed = mapping.policy(self.manifest, files)
        return mapping.build(self.root / 'operator', self.target, self.manifest, binding, allowed)

    def search(self, query, limit=50):
        return mapping.cached_search(self.manifest, query, limit, files, self.target)

    def test_names_paths_accents_and_unsupported_files_without_content(self):
        self.assertEqual(len(self.search('ofertes alpha')['results']), 1)
        self.assertEqual(self.search('program.exe')['results'][0]['kind'], 'file')
        self.assertTrue(self.search('missing')['limited'])
        self.assertFalse(self.search('missing')['sourceChecked'])
        with sqlite3.connect(self.target / 'catalogue.sqlite3') as db:
            self.assertEqual({r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}, {'entries', 'metadata'})
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM chunks').fetchone()[0], 0)

    def test_directory_pagination_and_unknown_path_fallback(self):
        first = self.search('server:/Y/Ofertes', 1)
        self.assertTrue(first['truncated'])
        second = self.search(first['nextQuery'], 1)
        self.assertNotEqual(first['results'][0]['path'], second['results'][0]['path'])
        self.assertIsNone(second['nextQuery'])
        self.assertIsNone(self.search('server:/Y/NotMapped'))
        self.assertEqual(len(self.search('server:/')['results']), 1)
        context = self.search('Ofertes')['results'][0]['folderContext']
        self.assertEqual(context['businessPurpose'], 'unconfirmed')
        self.assertEqual(context['observedFileTypes'], {'.pdf': 1, '.exe': 1})
        self.assertTrue(context['partial'])

    def test_guides_include_second_drive_when_first_drive_has_many_folders(self):
        with sqlite3.connect(self.target/'catalogue.sqlite3') as db:
            for n in range(140):
                source = 'C:\\System'+str(n)
                db.execute('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?)',(source.lower(),source,'c:',source[3:],'directory','',0,None,'2026-09-02T00:00:00Z','pending',source.lower()))
            meta = json.loads(db.execute('SELECT value FROM metadata').fetchone()[0])
        mapping.write_guides(self.target,meta)
        guide=(self.target/'README.md').read_text()
        self.assertIn('Y:',guide)
        self.assertIn('Ofertes',guide)

    def test_policy_change_cannot_reuse_old_map_or_reveal_denied_rows(self):
        self.access['readRoots'] = ['Y:\\Ofertes']
        self.assertIsNone(self.search('private'))
        self.build()
        self.assertEqual(self.search('private')['results'], [])
        with self.assertRaises(ValueError):
            self.search('server:/Y/Secret')

    def test_withdrawn_and_denied_descendants_are_not_projected(self):
        self.store.withdraw('Y:\\Secret\\private.txt', 'ACCESS_REVOKED')
        self.store.db.execute("UPDATE directories SET reason='SOURCE_ACCESS_DENIED',state='incomplete' WHERE source_key=?", ('y:\\secret',))
        self.store.db.commit()
        self.build()
        self.assertEqual(self.search('secret')['results'], [])

    def test_identity_and_symlink_boundaries(self):
        with self.assertRaisesRegex(ValueError, 'MAP_IDENTITY_MISMATCH'):
            mapping.cached_search({**self.manifest, 'installationId': 'other'}, 'alpha', 50, files, self.target)
        link = self.root / 'link'; link.symlink_to(self.target)
        with self.assertRaisesRegex(ValueError, 'UNSAFE_MAP_PATH'):
            mapping.cached_search(self.manifest, 'alpha', 50, files, link)

    def test_large_operator_store_projects_only_metadata_and_keeps_map_limit(self):
        self.store.db.commit()
        # A valid SQLite store can retain large free extents after indexing.
        # Sparse padding reproduces the physical-size rejection without copying
        # customer content or allocating hundreds of MiB in this regression.
        operator_db = self.root / 'operator' / 'catalogue.sqlite3'
        with operator_db.open('r+b') as handle:
            handle.truncate(256 * 1024 * 1024 + 4096)
        self.build()
        self.assertEqual(len(self.search('ofertes alpha')['results']), 1)
        projected = self.target / 'catalogue.sqlite3'
        self.assertLess(projected.stat().st_size, 256 * 1024 * 1024)
        with projected.open('r+b') as handle:
            handle.truncate(256 * 1024 * 1024 + 4096)
        with self.assertRaisesRegex(ValueError, 'MAP_SIZE_LIMIT'):
            self.search('alpha')

    def test_operator_reader_rejects_foreign_identity_without_replacing_map(self):
        original = (self.target / 'catalogue.sqlite3').read_bytes()
        self.store.db.execute("UPDATE identity SET installation='other'")
        self.store.db.commit()
        with self.assertRaisesRegex(ValueError, 'PARTITION_IDENTITY_MISMATCH'):
            self.build()
        self.assertEqual((self.target / 'catalogue.sqlite3').read_bytes(), original)

    def sharded_build(self, rows=2):
        with patch.object(mapping, 'SHARD_ROWS', rows):
            return self.build()

    def shard_paths(self):
        with sqlite3.connect(self.target / 'catalogue.sqlite3') as db:
            return [self.target / row[0] for row in db.execute('SELECT name FROM map_shards ORDER BY name')]

    def test_sharded_metadata_search_inventory_and_pagination_are_complete(self):
        self.store.db.execute("UPDATE directories SET state='pending',offset=0 WHERE source_key='y:\\ofertes'")
        self.store.db.commit()
        self.store.record_page(self.scan, 'Y:\\Ofertes', 0,
                               [self.entry('Y:\\Ofertes\\Pressupost Àlpha.pdf'), self.entry('Y:\\Ofertes\\program.exe')] +
                               [self.entry('Y:\\Ofertes\\extra' + str(n) + '.pdf') for n in range(5)], None)
        meta = self.sharded_build()
        self.assertGreater(meta['fragmentCount'], 1)
        self.assertEqual(meta['entries'], 9)
        first = self.search('server:/Y/Ofertes', 3)
        second = self.search(first['nextQuery'], 3)
        third = self.search(second['nextQuery'], 3)
        paths = [row['path'] for page in (first, second, third) for row in page['results']]
        self.assertEqual(len(paths), 7)
        self.assertEqual(len(set(paths)), 7)
        self.assertIsNone(third['nextQuery'])
        self.assertEqual(len(self.search('extra')['results']), 5)
        inventory = mapping.folder_inventory(self.manifest, 'server-fictional/Y/', 0, files, self.target)
        self.assertEqual(inventory['fileCount'], 7)
        db = mapping.readonly(self.target / 'catalogue.sqlite3')
        try:
            self.assertEqual(db.execute('SELECT count(*) FROM entries').fetchone()[0], 9)
            with self.assertRaises(sqlite3.OperationalError):
                db.execute('DELETE FROM fragment_0.entries')
        finally:
            db.close()
        with sqlite3.connect(self.target / 'catalogue.sqlite3') as db:
            self.assertEqual({r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}, {'metadata', 'map_shards'})
        for shard in self.shard_paths():
            self.assertEqual(shard.stat().st_mode & 0o777, 0o600)
            with sqlite3.connect(shard) as db:
                self.assertEqual({r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}, {'metadata', 'entries'})
                self.assertLessEqual(db.execute('SELECT count(*) FROM entries').fetchone()[0], 2)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM chunks').fetchone()[0], 0)

    def test_sharded_lookup_keeps_policy_denial_and_does_not_hash_full_map(self):
        self.sharded_build()
        with patch.object(mapping, 'file_hash', side_effect=AssertionError('Lookup must not hash all metadata')):
            self.assertEqual(len(self.search('alpha')['results']), 1)
        self.access['readRoots'] = ['Y:\\Ofertes']
        self.assertIsNone(self.search('private'))
        self.sharded_build()
        self.assertEqual(self.search('private')['results'], [])
        with self.assertRaises(ValueError):
            self.search('server:/Y/Secret')

    def test_fragment_limit_and_guide_failure_preserve_old_map_and_fragments(self):
        self.sharded_build()
        original = (self.target / 'catalogue.sqlite3').read_bytes()
        old = {p.name: p.read_bytes() for p in self.shard_paths()}
        with patch.object(mapping, 'MAX_SHARDS', 1), patch.object(mapping, 'SHARD_ROWS', 2):
            with self.assertRaisesRegex(ValueError, 'MAP_SHARD_LIMIT'):
                self.build()
        with patch.object(mapping, 'write_guides', side_effect=OSError('synthetic guide failure')):
            with self.assertRaises(OSError):
                self.sharded_build()
        self.assertEqual((self.target / 'catalogue.sqlite3').read_bytes(), original)
        self.assertEqual({p.name: p.read_bytes() for p in self.shard_paths()}, old)
        self.assertEqual({p.name for p in self.target.glob('fragment-*.sqlite3')}, set(old))
        self.assertFalse(list(self.target.glob('.catalogue-*')))
        self.assertFalse(list(self.target.glob('.map-index-*')))

    def test_policy_drift_before_publication_preserves_previous_map(self):
        original = (self.target / 'catalogue.sqlite3').read_bytes()
        def drift(*_args, **_kwargs):
            self.access['readRoots'] = ['Y:\\Secret']
        with patch.object(mapping, 'write_guides', side_effect=drift):
            with self.assertRaisesRegex(ValueError, 'MAP_POLICY_CHANGED'):
                self.sharded_build()
        self.assertEqual((self.target / 'catalogue.sqlite3').read_bytes(), original)

    def test_oversized_new_fragment_fails_before_replacing_old_map(self):
        original = (self.target / 'catalogue.sqlite3').read_bytes()
        with patch.object(mapping, 'MAX_MAP_BYTES', 4096):
            with self.assertRaisesRegex(ValueError, 'MAP_SIZE_LIMIT'):
                self.sharded_build()
        self.assertEqual((self.target / 'catalogue.sqlite3').read_bytes(), original)
        self.assertFalse(list(self.target.glob('fragment-*.sqlite3')))

    def test_denial_prefix_memory_budget_fails_closed_without_replacing_map(self):
        original = (self.target / 'catalogue.sqlite3').read_bytes()
        self.store.db.execute("UPDATE directories SET reason='SOURCE_POLICY_DENIED'")
        self.store.db.commit()
        with patch.object(mapping, 'MAX_BLOCKED_PREFIXES', 1):
            with self.assertRaisesRegex(ValueError, 'MAP_DENIAL_PREFIX_LIMIT'):
                self.sharded_build()
        self.assertEqual((self.target / 'catalogue.sqlite3').read_bytes(), original)

    def test_fragment_hash_checked_before_publication_not_after_old_map_replaced(self):
        original = (self.target / 'catalogue.sqlite3').read_bytes()
        reader = mapping.readonly
        def corrupt(path, verify_hashes=False):
            if verify_hashes:
                with sqlite3.connect(path) as db:
                    name = db.execute('SELECT name FROM map_shards ORDER BY name LIMIT 1').fetchone()[0]
                with (self.target / name).open('ab') as stream:
                    stream.write(b'corruption')
            return reader(path, verify_hashes=verify_hashes)
        with patch.object(mapping, 'readonly', side_effect=corrupt):
            with self.assertRaisesRegex(ValueError, 'MAP_SHARD_HASH_MISMATCH'):
                self.sharded_build()
        self.assertEqual((self.target / 'catalogue.sqlite3').read_bytes(), original)
        self.assertFalse(list(self.target.glob('fragment-*.sqlite3')))

    def test_sharded_reader_validates_names_identity_permissions_and_size(self):
        self.sharded_build()
        index = self.target / 'catalogue.sqlite3'
        original_index = index.read_bytes()
        with sqlite3.connect(index) as db:
            db.execute("UPDATE map_shards SET name='../outside.sqlite3' WHERE name=(SELECT min(name) FROM map_shards)")
        with self.assertRaisesRegex(ValueError, 'MAP_SHARD_NAME_INVALID'):
            self.search('alpha')
        index.write_bytes(original_index)
        self.sharded_build()
        shard = self.shard_paths()[0]
        original_shard = shard.read_bytes()
        with sqlite3.connect(shard) as db:
            meta = json.loads(db.execute('SELECT value FROM metadata').fetchone()[0])
            meta['installationId'] = 'foreign'
            db.execute('UPDATE metadata SET value=?', (json.dumps(meta),))
        with self.assertRaisesRegex(ValueError, 'MAP_SHARD_IDENTITY_MISMATCH'):
            self.search('alpha')
        shard.write_bytes(original_shard)
        self.sharded_build()
        shard = self.shard_paths()[0]
        shard.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'PRIVATE_MAP_REQUIRED'):
            self.search('alpha')
        shard.chmod(0o600)
        with shard.open('r+b') as stream:
            stream.truncate(mapping.MAX_MAP_BYTES + 4096)
        with self.assertRaisesRegex(ValueError, 'MAP_SIZE_LIMIT'):
            self.search('alpha')

    def test_sharded_reader_rejects_symlink_fragment(self):
        self.sharded_build()
        shard = self.shard_paths()[0]
        moved = self.root / 'outside.sqlite3'
        shard.rename(moved)
        shard.symlink_to(moved)
        with self.assertRaisesRegex(ValueError, 'UNSAFE_MAP_PATH'):
            self.search('alpha')

    def test_four_generations_retain_only_current_previous_and_original_legacy(self):
        legacy = (self.target / 'catalogue.sqlite3').read_bytes()
        legacy_inode = (self.target / 'catalogue.sqlite3').stat().st_ino
        last = set()
        for _ in range(4):
            self.sharded_build()
            current = set(self.shard_paths())
            self.assertEqual(set(self.target.glob('fragment-*.sqlite3')), current | last)
            if last:
                db = mapping.readonly(self.target / 'catalogue.previous.sqlite3')
                try:
                    self.assertEqual(db.execute('SELECT count(*) FROM entries').fetchone()[0], 4)
                finally:
                    db.close()
            last = current
            self.assertEqual((self.target / 'catalogue.legacy.sqlite3').read_bytes(), legacy)
            self.assertEqual((self.target / 'catalogue.legacy.sqlite3').stat().st_ino, legacy_inode)
        self.assertFalse(list(self.target.glob('.map-previous')))

    def test_interrupted_retirement_recovers_without_growing_generations(self):
        self.sharded_build()
        oldest = set(self.shard_paths())
        self.sharded_build()
        unlink = Path.unlink
        failed = False
        def interrupted(path, *args, **kwargs):
            nonlocal failed
            if path in oldest and not failed:
                failed = True
                raise OSError('synthetic interrupted retirement')
            return unlink(path, *args, **kwargs)
        with patch.object(Path, 'unlink', interrupted):
            with self.assertRaises(OSError):
                self.sharded_build()
        self.assertEqual(len(self.search('alpha')['results']), 1)
        self.sharded_build()
        self.assertFalse(any(p.exists() for p in oldest))
        current = set(self.shard_paths())
        previous = mapping.retained_fragments(self.target / 'catalogue.previous.sqlite3', self.manifest)
        self.assertEqual(set(self.target.glob('fragment-*.sqlite3')), current | set(previous))

    @unittest.skipUnless(hasattr(os, 'fork'), 'Abrupt process termination requires fork')
    def test_abrupt_exit_between_index_replaces_recovers_immediate_rollback_before_retirement(self):
        self.sharded_build()
        oldest = set(self.shard_paths())
        self.sharded_build()
        rollback = set(self.shard_paths())
        rollback_index = (self.target / 'catalogue.sqlite3').read_bytes()
        replace = os.replace
        child = os.fork()
        if child == 0:
            def crash_after_publish(source, destination):
                replace(source, destination)
                if Path(source).name.startswith('.map-index-') and Path(destination).name == 'catalogue.sqlite3':
                    os._exit(73)  # Kernel closes locks; Python finally never runs.
            mapping.os.replace = crash_after_publish
            try:
                self.sharded_build()
            except BaseException:
                os._exit(74)
            os._exit(75)
        _, status = os.waitpid(child, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), 73)
        pending = self.target / '.map-previous'
        self.assertEqual(pending.read_bytes(), rollback_index)
        current_index = (self.target / 'catalogue.sqlite3').read_bytes()
        current = set(self.shard_paths())
        self.assertTrue(all(p.exists() for p in rollback | current | oldest))
        # The following attempt fails before publication: recovery must already
        # have installed/protected the crashed operation's immediate rollback.
        def fail_new_publication(source, destination):
            if Path(source).name.startswith('.map-index-') and Path(destination).name == 'catalogue.sqlite3':
                self.assertEqual((self.target / 'catalogue.previous.sqlite3').read_bytes(), rollback_index)
                self.assertTrue(all(p.exists() for p in rollback))
                raise OSError('synthetic later publication failure')
            return replace(source, destination)
        with patch.object(mapping.os, 'replace', side_effect=fail_new_publication):
            with self.assertRaises(OSError):
                self.sharded_build()
        self.assertFalse(pending.exists())
        self.assertEqual((self.target / 'catalogue.sqlite3').read_bytes(), current_index)
        self.assertEqual((self.target / 'catalogue.previous.sqlite3').read_bytes(), rollback_index)
        self.assertEqual(set(self.target.glob('fragment-*.sqlite3')), current | rollback)
        self.assertEqual(len(self.search('alpha')['results']), 1)
        self.sharded_build()
        self.assertEqual(set(mapping.retained_fragments(self.target / 'catalogue.previous.sqlite3', self.manifest)), current)

    def test_preexisting_pending_rollback_survives_validation_failure(self):
        self.sharded_build()
        pending = self.target / '.map-previous'
        pending.write_bytes((self.target / 'catalogue.sqlite3').read_bytes())
        pending.chmod(0o600)
        original = pending.read_bytes()
        with patch.object(mapping, 'write_guides', side_effect=OSError('synthetic early failure')):
            with self.assertRaises(OSError):
                self.sharded_build()
        self.assertEqual(pending.read_bytes(), original)
        self.sharded_build()  # Same-generation pending reference is safely resolved.
        self.assertFalse(pending.exists())

    def test_retirement_refuses_foreign_or_content_bearing_fragment_without_removal(self):
        self.sharded_build()
        orphan = self.target / ('fragment-' + 'f' * 32 + '-00.sqlite3')
        source = self.shard_paths()[0]
        orphan.write_bytes(source.read_bytes())
        orphan.chmod(0o600)
        original = (self.target / 'catalogue.sqlite3').read_bytes()
        with self.assertRaisesRegex(ValueError, 'MAP_RETIREMENT_NOT_DERIVED'):
            self.sharded_build()
        self.assertEqual((self.target / 'catalogue.sqlite3').read_bytes(), original)
        self.assertTrue(orphan.exists())

    def test_interrupted_first_legacy_link_recovers_original_inode(self):
        index = self.target / 'catalogue.sqlite3'
        original = index.read_bytes()
        inode = index.stat().st_ino
        os.link(index, self.target / 'catalogue.legacy.sqlite3')
        self.sharded_build()
        restored = self.target / 'catalogue.legacy.sqlite3'
        self.assertEqual(restored.stat().st_ino, inode)
        self.assertEqual(restored.stat().st_nlink, 1)
        self.assertEqual(restored.read_bytes(), original)

    def test_reader_connection_holds_generation_until_close_and_blocks_retirement(self):
        self.sharded_build()
        original = (self.target / 'catalogue.sqlite3').read_bytes()
        old_fragments = self.shard_paths()
        reader = mapping.readonly(self.target / 'catalogue.sqlite3')
        waiting, finished = threading.Event(), threading.Event()
        errors = []
        flock = mapping.fcntl.flock
        def observed(fd, mode):
            if mode == mapping.fcntl.LOCK_EX and list(self.target.glob('.map-index-*')):
                waiting.set()
            return flock(fd, mode)
        def rebuild():
            try:
                self.sharded_build()
            except Exception as error:
                errors.append(error)
            finally:
                finished.set()
        with patch.object(mapping.fcntl, 'flock', side_effect=observed):
            worker = threading.Thread(target=rebuild)
            worker.start()
            try:
                self.assertTrue(waiting.wait(3))
                self.assertFalse(finished.is_set())
                self.assertEqual((self.target / 'catalogue.sqlite3').read_bytes(), original)
                self.assertTrue(all(p.exists() for p in old_fragments))
                self.assertEqual(reader.execute('SELECT count(*) FROM entries').fetchone()[0], 4)
            finally:
                reader.close()
                worker.join(3)
            self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertTrue(all(p.exists() for p in old_fragments))  # previous generation
        self.sharded_build()
        self.assertFalse(any(p.exists() for p in old_fragments))

    def test_reader_already_holds_shared_lock_during_first_fragment_attach(self):
        self.sharded_build()
        attaching, release, publishing = threading.Event(), threading.Event(), threading.Event()
        errors = []
        execute, flock = mapping.MapConnection.execute, mapping.fcntl.flock
        def paused(connection, sql, *args, **kwargs):
            if sql.startswith('ATTACH DATABASE') and threading.current_thread().name == 'map-reader':
                attaching.set()
                if not release.wait(3):
                    raise AssertionError('Reader release timed out')
            return execute(connection, sql, *args, **kwargs)
        def observed(fd, mode):
            if mode == mapping.fcntl.LOCK_EX and list(self.target.glob('.map-index-*')):
                publishing.set()
            return flock(fd, mode)
        def read():
            try:
                db = mapping.readonly(self.target / 'catalogue.sqlite3')
                try:
                    self.assertEqual(db.execute('SELECT count(*) FROM entries').fetchone()[0], 4)
                finally:
                    db.close()
            except Exception as error:
                errors.append(error)
        def rebuild():
            try:
                self.sharded_build()
            except Exception as error:
                errors.append(error)
        with patch.object(mapping.MapConnection, 'execute', paused), patch.object(mapping.fcntl, 'flock', side_effect=observed):
            reader = threading.Thread(target=read, name='map-reader')
            writer = threading.Thread(target=rebuild, name='map-writer')
            reader.start()
            self.assertTrue(attaching.wait(3))
            old_index = (self.target / 'catalogue.sqlite3').read_bytes()
            writer.start()
            try:
                self.assertTrue(publishing.wait(3))
                self.assertTrue(writer.is_alive())
                self.assertEqual((self.target / 'catalogue.sqlite3').read_bytes(), old_index)
            finally:
                release.set()
                reader.join(3)
                writer.join(3)
            self.assertFalse(reader.is_alive())
            self.assertFalse(writer.is_alive())
        self.assertEqual(errors, [])

    def test_rebuild_preserves_entry_time_and_generates_bounded_factual_guides(self):
        first = self.search('alpha')['results'][0]['observedAt']
        self.build()
        self.assertEqual(self.search('alpha')['results'][0]['observedAt'], first)
        self.assertIn('pendiente de confirmar', (self.target / 'README.md').read_text())
        self.assertEqual((self.target / 'catalogue.sqlite3').stat().st_mode & 0o777, 0o600)
        self.assertTrue(list((self.target / 'folders').glob('*.md')))

    def test_query_is_literal_data_and_does_not_execute_sql(self):
        self.assertEqual(self.search("' OR 1=1 --")['results'], [])
        self.assertEqual(self.search('%')['results'], [])

    def test_pending_folder_uses_live_listing_instead_of_empty_cache(self):
        self.store.db.execute("UPDATE directories SET state='pending' WHERE source_key='y:\\ofertes'")
        self.store.db.commit()
        self.build()
        self.assertIsNone(self.search('server:/Y/Ofertes'))

    def test_partial_directory_with_known_children_remains_browsable(self):
        self.store.db.execute("UPDATE directories SET state='incomplete' WHERE source_key='y:\\ofertes'")
        self.store.db.commit()
        self.build()
        self.assertEqual(len(self.search('server:/Y/Ofertes')['results']), 2)
        self.assertTrue(self.search('server:/Y/Ofertes')['limited'])

    def test_inventory_counts_whole_subtree_not_just_page_and_preserves_unknowns(self):
        self.store.db.execute("UPDATE directories SET state='pending',offset=0 WHERE source_key='y:\\ofertes'")
        self.store.db.commit()
        entries = [self.entry('Y:\\Ofertes\\file'+str(n)+'.pdf') for n in range(49)] + [self.entry('Y:\\Ofertes\\Child', True)]
        self.store.record_page(self.scan, 'Y:\\Ofertes', 0, entries, 50)
        self.store.record_page(self.scan, 'Y:\\Ofertes', 50, [self.entry('Y:\\Ofertes\\last.jpg')], None)
        self.build()
        result = mapping.folder_inventory(self.manifest, 'server-fictional/Y/Ofertes', 0, files, self.target)
        self.assertEqual(result['fileCount'], 52)  # includes two earlier observations
        self.assertEqual(len(result['results']), 50)
        self.assertEqual(result['nextOffset'], 50)
        self.assertFalse(result['enumerationComplete'])
        self.assertIsNone(result['businessRecordCount'])
        self.store.record_page(self.scan, 'Y:\\Ofertes\\Child', 0, [self.entry('Y:\\Ofertes\\Child\\nested.pdf')], None)
        self.build()
        second = mapping.folder_inventory(self.manifest, 'server-fictional/Y/Ofertes', 50, files, self.target)
        self.assertEqual(second['fileCount'], 53)
        self.assertEqual(len(second['results']), 3)
        self.assertTrue(second['enumerationComplete'])
        self.assertFalse(second['sourceChecked'])
        self.assertFalse(second['snapshot'])
        self.assertEqual(second['fileTypes']['.pdf'], 51)

    def test_inventory_known_empty_unknown_and_denied_are_distinct(self):
        self.store.db.execute('INSERT INTO directories(scan,source_key,source) VALUES(?,?,?)', (self.scan, 'y:\\empty', 'Y:\\Empty'))
        self.store.db.commit()
        self.store.record_page(self.scan, 'Y:\\Empty', 0, [], None)
        self.build()
        empty = mapping.folder_inventory(self.manifest, 'server-fictional/Y/Empty', 0, files, self.target)
        self.assertEqual(empty['fileCount'], 0)
        self.assertTrue(empty['enumerationComplete'])
        self.assertIsNone(mapping.folder_inventory(self.manifest, 'server-fictional/Y/Missing', 0, files, self.target))
        with self.assertRaises(ValueError):
            mapping.folder_inventory(self.manifest, 'server-fictional/Y/Ofertes?part=1', 0, files, self.target)
        self.store.db.execute("UPDATE directories SET reason='SOURCE_ACCESS_DENIED',state='incomplete' WHERE source_key='y:\\secret'")
        self.store.db.commit()
        self.build()
        root = mapping.folder_inventory(self.manifest, 'server-fictional/Y/', 0, files, self.target)
        self.assertFalse(root['enumerationComplete'])
        self.assertEqual(root['fileCount'], 2)
        with self.assertRaises(ValueError):
            mapping.folder_inventory(self.manifest, 'server-fictional/Y/Secret', 0, files, self.target)
        self.access['readRoots'] = ['Y:\\Secret']
        with self.assertRaises(ValueError):
            mapping.folder_inventory(self.manifest, 'server-fictional/Y/Ofertes', 0, files, self.target)

    def test_demand_fill_resumes_only_target_and_never_content(self):
        demand = load('test_folder_demand', 'knowledge-folder-inventory.py')
        self.store.db.execute("UPDATE directories SET state='pending',offset=0")
        self.store.db.commit()
        requests = []
        def run(_, request):
            requests.append(request)
            offset = request['offset']
            return {'ok': True, 'entries': [self.entry('Y:\\Ofertes\\item'+str(n)+'.txt') for n in range(offset, offset+50)],
                    'truncated': True, 'nextOffset': offset+50}
        result = demand.fill(self.store, self.manifest, self.scan, 'Y:\\Ofertes', run)
        self.assertEqual(result, {'pagesRead': 2, 'state': 'CONTINUE'})
        self.assertEqual([r['offset'] for r in requests], [0, 50])
        self.assertTrue(all(r['source'] == 'Y:\\Ofertes' and r['mode'] == 'list' for r in requests))
        self.assertEqual(demand.next_directory(self.store, self.scan, 'Y:\\Ofertes')['offset'], 100)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM chunks').fetchone()[0], 0)
        busy = demand.fill(self.store, self.manifest, self.scan, 'Y:\\Ofertes', lambda *_: (_ for _ in ()).throw(BlockingIOError()))
        self.assertEqual(busy, {'pagesRead': 0, 'state': 'SOURCE_BUSY'})
        self.assertEqual(demand.next_directory(self.store, self.scan, 'Y:\\Ofertes')['attempts'], 0)
        self.assertIsNone(demand.next_directory(self.store, self.scan, 'Y:\\Oferte'))

    def test_background_yields_between_pages_and_expired_marker_is_ignored(self):
        demand = load('test_folder_yield', 'knowledge-folder-inventory.py')
        import time
        marker = self.root / 'operator' / 'interactive-until'
        mapping.atomic_text(marker, str(time.time()+100))
        self.assertTrue(demand.inventory.demand_pending(marker.parent))
        result = demand.inventory.run_batch(self.store, self.manifest, self.scan,
                    run=lambda *_: self.fail('Background did not yield'), should_yield=lambda: True)
        self.assertEqual(result['paused'], 'INTERACTIVE_REQUEST')
        mapping.atomic_text(marker, '0')
        self.assertFalse(demand.inventory.demand_pending(marker.parent))

    def test_live_demand_does_not_wait_for_local_catalogue_rebuild(self):
        demand = load('test_live_demand', 'knowledge-folder-inventory.py')
        from unittest.mock import patch
        operator = self.root / 'operator'
        (operator / 'inventory.lock').touch()
        with patch.object(demand.mapping, 'map_root', return_value=self.root / 'server-map'), \
             patch.object(demand.fcntl, 'flock', side_effect=AssertionError('Live browsing must not acquire the catalogue lock')):
            with demand.interactive_access(self.manifest, catalogue=False):
                self.assertTrue(demand.inventory.demand_pending(operator))
        self.assertTrue(demand.inventory.demand_pending(operator))
        import time
        with patch.object(demand.inventory.time, 'time', return_value=time.time()+16):
            self.assertFalse(demand.inventory.demand_pending(operator))

    def test_schedule_has_only_metadata_source_operations(self):
        unit = (INFRA / 'aibrain-arnall-knowledge-inventory.service').read_text()
        self.assertIn('knowledge-inventory.py', unit)
        self.assertIn('knowledge-map.py', unit)
        for forbidden in ('knowledge-ingest.py', 'knowledge-reconcile.py', 'knowledge-publish.py'):
            self.assertNotIn(forbidden, unit)


if __name__ == '__main__':
    unittest.main()
