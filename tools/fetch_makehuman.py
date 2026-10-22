# MakeHuman(CC0) 원본 자산 받기 → build_human.py가 쓰는 폴더(기본: 프로젝트/assets-src/makehuman, git 제외)
# 사용: python -X utf8 tools/fetch_makehuman.py [받을 폴더]
# - 기본 메시·뼈대·눈 메시·타깃: makehumancommunity/makehuman (makehuman/data)
# - 피부·머리카락·눈썹·속눈썹·눈 색·신발·옷: dmaugis/makehuman-py3-assets (base/, MakeHuman 시스템 자산 거울. 그림은 Git LFS)
# 둘 다 MakeHuman 번들 자산이며 CC0 1.0(makehuman license.txt "C. The license for the bundled assets"). 계정 없이 받는다.
# 이미 받은 파일(크기 0 아님)은 건너뛴다. 타깃 목록은 build_human.py의 PAIRS·FACE 정의에서 읽는다(새 타깃을 넣으면 자동으로 받는다).
import json, os, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'assets-src', 'makehuman')
MH = ('makehumancommunity/makehuman', 'master', 'makehuman/data/')
AS = ('dmaugis/makehuman-py3-assets', 'master', 'base/')

# 받을 파일: 저장 이름 → (저장소, 저장소 안 경로)
FILES = {
    'base.obj': (MH, '3dobjs/base.obj'),
    'default.mhskel': (MH, 'rigs/default.mhskel'),
    'default_weights.mhw': (MH, 'rigs/default_weights.mhw'),
    'eyes.mhclo': (MH, 'eyes/high-poly/high-poly.mhclo'),  # 눈알(고해상도)
    'eyes.obj': (MH, 'eyes/high-poly/high-poly.obj'),
    'skin_diffuse.png': (AS, 'skins/textures/young_lightskinned_male_diffuse3.png'),  # young_asian_male 피부가 쓰는 그림
    'brownlight_eye.png': (AS, 'eyes/materials/brownlight_eye.png'),
}
for name, folder, extra in [
    ('short02', 'hair/short02', ['short02_diffuse.png', 'short02_normal.png']),
    ('eyebrow008', 'eyebrows/eyebrow008', ['eyebrow008.png']),
    ('eyelashes01', 'eyelashes/eyelashes01', ['eyelashes01.png']),
    ('shoes05', 'clothes/shoes05', ['shoes05_diffuse.png']),
    ('male_casualsuit02', 'clothes/male_casualsuit02', ['male_casualsuit02_ao.png', 'male_casualsuit02_diffuse.png', 'male_casualsuit02_normal.png']),
    ('male_casualsuit04', 'clothes/male_casualsuit04', ['male_casualsuit04_ao.png', 'male_casualsuit04_diffuse.png', 'male_casualsuit04_normal.png']),
]:
    for f in [name + '.mhclo', name + '.obj'] + extra:
        FILES[f] = (AS, folder + '/' + f)


def needed_targets():
    """build_human.py의 PAIRS·FACE 정의 부분만 실행해 쓰는 타깃 이름을 모은다"""
    src = open(os.path.join(ROOT, 'tools', 'build_human.py'), encoding='utf-8').read()
    i = src.index('PAIRS = {')
    j = src.index("if os.path.exists(os.path.join(DL, 't', 'head-oval.target'))")
    ns = {}
    exec(src[i:j], ns)
    names = {'asian-male-young', 'male-young-averagemuscle-averageweight-idealproportions'}  # 기본 체형(build_human.py 위쪽)
    for d in (ns['PAIRS'], ns['FACE']):
        for pair in d.values():
            for n in pair:
                if n: names |= set(n.split('+'))
    return sorted(names)


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'fitcheck-fetch'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def fetch(repo, path):
    (slug, branch, prefix) = repo
    data = get('https://raw.githubusercontent.com/%s/%s/%s%s' % (slug, branch, prefix, path))
    if data.startswith(b'version https://git-lfs'):  # Git LFS 포인터면 실제 파일은 media 주소에서
        data = get('https://media.githubusercontent.com/media/%s/%s/%s%s' % (slug, branch, prefix, path))
    return data


def main():
    os.makedirs(os.path.join(DEST, 't'), exist_ok=True)
    jobs = [(name, repo, path) for name, (repo, path) in FILES.items()]
    # 타깃은 폴더가 여러 갈래라 저장소 목록에서 경로를 찾는다
    tree = json.loads(get('https://api.github.com/repos/%s/git/trees/%s?recursive=1' % (MH[0], MH[1])))
    where = {}
    for x in tree['tree']:
        p = x['path']
        if p.startswith(MH[2] + 'targets/') and p.endswith('.target'): where[os.path.basename(p)[:-7]] = p[len(MH[2]):]
    missing = [n for n in needed_targets() if n not in where]
    if missing: sys.exit('저장소에서 찾지 못한 타깃: %s' % missing)
    jobs += [('t/' + n + '.target', MH, where[n]) for n in needed_targets()]
    got = 0
    for name, repo, path in jobs:
        out = os.path.join(DEST, name)
        if os.path.exists(out) and os.path.getsize(out) > 0: continue
        data = fetch(repo, path)
        with open(out, 'wb') as f: f.write(data)
        got += 1
        print('%-40s %8d  %s' % (name, len(data), path))
    print('받음 %d, 전체 %d → %s' % (got, len(jobs), DEST))


if __name__ == '__main__':
    main()
