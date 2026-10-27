"""0.6.0：S0/S1 预计算缓存必须是 LRU 有界，批量导入不随图片数增长。"""

import numpy as np

from engine.pipeline import ART_CACHE_MAX, ConversionPipeline
from engine.recipe import Recipe


def _pipe() -> tuple[ConversionPipeline, Recipe]:
    pipe = ConversionPipeline()
    recipe = Recipe()
    recipe.raw["preprocess"]["bilateral"]["enable"] = False  # 小图测试无需去噪
    return pipe, recipe


def test_art_cache_bounded():
    pipe, recipe = _pipe()
    for i in range(ART_CACHE_MAX + 3):
        pipe._precompute(np.full((8, 8, 3), i * 10, np.uint8), recipe)
        assert len(pipe._art_cache) <= ART_CACHE_MAX
    assert len(pipe._art_cache) == ART_CACHE_MAX


def test_art_cache_hit_moves_to_end():
    pipe, recipe = _pipe()
    images = [np.full((8, 8, 3), i * 10, np.uint8) for i in range(ART_CACHE_MAX)]
    keys = [pipe._art_cache_key(img, recipe) for img in images]
    for img in images:
        pipe._precompute(img, recipe)

    # 访问最早的一项 → 提到队尾；再插入新图应淘汰第二旧（keys[1]）而非 keys[0]
    pipe._precompute(images[0], recipe)
    pipe._precompute(np.full((8, 8, 3), 255, np.uint8), recipe)

    assert keys[0] in pipe._art_cache
    assert keys[1] not in pipe._art_cache
