"""Refresh the offline cultivar index from a pinned CC0 OpenPlantDB plants.csv.

Download the CSV at the URL printed by --help, then pass its local path.
The version and digest must be reviewed together when updating the snapshot.
"""
import argparse
import csv
import hashlib
import json
import re
import unicodedata
from collections import defaultdict
from pathlib import Path

REVISION = '91cbe3b86c6f5fddb6b8cab6d9505c630f36ea7f'
DIGEST = '4b83bb5e21e1cf660b14941497060a45ad6e25d39ab4f13fc94774c2b5fa8a71'
URL = f'https://raw.githubusercontent.com/cwfrazier1/openplantdb/{REVISION}/data/plants.csv'
APP = Path(__file__).resolve().parents[1] / 'index.html'


def fold(value):
    plain = unicodedata.normalize('NFKD', value.casefold())
    return ' '.join(re.findall(r'[a-z0-9]+', ''.join(c for c in plain if not unicodedata.combining(c))))


def conditions(row):
    light = {'full': 'Full sun', 'partial': 'Partial sun', 'shade': 'Shade'}.get(row['sun'], '')
    water = {'low': 'Low', 'moderate': 'Moderate', 'high': 'High'}.get(row['water'], '')
    a, b = row['spacing_in_min'], row['spacing_in_max']
    spacing = ''
    if a.isdigit() and b.isdigit() and 0 < int(a) <= int(b) <= 1200:
        spacing = a if a == b else f'{a}–{b}'
    return [light, water, spacing, row['season'] if row['season'] in ('cool', 'warm', 'perennial') else '']


def build(csv_path):
    if hashlib.sha256(csv_path.read_bytes()).hexdigest() != DIGEST:
        raise ValueError('CSV does not match the pinned OpenPlantDB release.')
    html = APP.read_text()
    block = re.search(r'<script id="reference-data" type="application/json">(.*?)</script>', html, re.S)
    db = json.loads(block[1])
    parents = defaultdict(list)
    known = set()
    curated = {}
    # Exact parent matches only. Shared species groups need explicit treatment.
    for crop in db['crops']:
        crop.pop('databaseInfo', None)
        meta = crop.get('plantLookup', {})
        if meta.get('cultivar'):
            key = (meta['scientific'], fold(meta['cultivar']))
            known.add(key)
            curated[key] = crop
        else:
            for species in crop['scientific'].split(' / '):
                if not species.endswith('spp.'):
                    parents[species].append(crop)
    by_id = {c['id']: c for c in db['crops']}
    for species, crop_id in {'Zinnia elegans':'zinnia','Helianthus annuus':'sunflower','Cosmos bipinnatus':'cosmos','Tropaeolum majus':'nasturtium','Thymus vulgaris':'thyme'}.items():
        parents[species] = [by_id[crop_id]]
    # A species name alone cannot assign a pepper's heat or a squash's market class.
    parents.pop('Capsicum annuum', None)
    extras = []
    with csv_path.open(encoding='utf-8', newline='') as records:
        for row in csv.DictReader(records):
            taxon = row['scientific_name'].strip()
            match = re.fullmatch(r"(.+?) '(.{1,90})'", taxon)
            species = match[1] if match else taxon
            choices = parents.get(species, [])
            words = fold(row['common_name'] + ' ' + row['subcategory'])
            if species in ('Capsicum annuum', 'Capsicum chinense', 'Capsicum frutescens') and row['category'] == 'vegetable':
                if re.search(r'\b(bell|sweet pepper)\b', words):
                    choices = [by_id['sweetpepper']]
                elif re.search(r'\b(jalapeno|serrano|cayenne|hot pepper|hot chile)\b', words):
                    choices = [by_id['hotpepper']]
            if species in ('Cucurbita pepo', 'Cucurbita moschata', 'Cucurbita maxima'):
                if re.search(r'\bpumpkin\b', words):
                    choices = [by_id['pumpkin']]
                elif re.search(r'\b(squash|zucchini)\b', words):
                    choices = [by_id['squash']]
            if len(choices) != 1:
                continue
            parent = choices[0]
            if not match:
                labels = [parent['name'], parent['scientific'], *parent.get('aliases', [])]
                if any(fold(label) == fold(row['common_name']) or fold(label) == fold(row['slug']) for label in labels):
                    if 'databaseInfo' not in parent:
                        parent['databaseInfo'] = [row['slug'], *conditions(row)]
                continue
            cultivar = match[2]
            key = (species, fold(cultivar))
            if not key[1]:
                continue
            if key in curated and 'databaseInfo' not in curated[key]:
                curated[key]['databaseInfo'] = [row['slug'], *conditions(row)]
            if key in known:
                continue
            known.add(key)
            extras.append([row['slug'], parent['id'], cultivar, species, row['common_name'], *conditions(row)])
    db['openPlantDB'] = {'revision': REVISION, 'varieties': sorted(extras)}
    encoded = json.dumps(db, separators=(',', ':'), ensure_ascii=False).replace('</', '<\\/')
    APP.write_text(html[:block.start(1)] + encoded + html[block.end(1):])
    print(f'{len(extras)} additional cultivar records, {len(db["crops"])} core records')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=f'Import the pinned CC0 gardening CSV from {URL}')
    parser.add_argument('csv', type=Path)
    build(parser.parse_args().csv)
