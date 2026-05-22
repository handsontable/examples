<?php

namespace App\Http\Controllers;

use App\Models\Product;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class ProductController extends Controller
{
    private const ALLOWED_COLUMNS = ['name', 'sku', 'category', 'price', 'stock'];

    // GET /api/products
    // Query string sent by Handsontable via buildUrl():
    //   page, pageSize, sort[prop], sort[order],
    //   filters[0][prop], filters[0][condition], filters[0][value], filters[0][value2]
    public function index(Request $request): JsonResponse
    {
        $page     = (int) $request->input('page', 1);
        $pageSize = (int) $request->input('pageSize', 10);
        $sort     = $request->input('sort');
        $filters  = $request->input('filters');

        $query = Product::query();

        // --- Filtering -------------------------------------------------------
        if (is_array($filters)) {
            foreach ($filters as $filter) {
                $prop      = $filter['prop']      ?? null;
                $condition = $filter['condition'] ?? null;
                $value     = $filter['value']     ?? null;
                $value2    = $filter['value2']    ?? null;

                if (!$prop || !$condition || !in_array($prop, self::ALLOWED_COLUMNS, true)) {
                    continue;
                }

                switch ($condition) {
                    case 'contains':
                        $safe = $this->escapeLike(strtolower((string)$value));
                        $query->whereRaw("LOWER({$prop}) LIKE ?", ['%' . $safe . '%']);
                        break;
                    case 'not_contains':
                        $safe = $this->escapeLike(strtolower((string)$value));
                        $query->whereRaw("LOWER({$prop}) NOT LIKE ?", ['%' . $safe . '%']);
                        break;
                    case 'begins_with':
                        $safe = $this->escapeLike(strtolower((string)$value));
                        $query->whereRaw("LOWER({$prop}) LIKE ?", [$safe . '%']);
                        break;
                    case 'ends_with':
                        $safe = $this->escapeLike(strtolower((string)$value));
                        $query->whereRaw("LOWER({$prop}) LIKE ?", ['%' . $safe]);
                        break;
                    case 'eq':    $query->where($prop, '=', $value);  break;
                    case 'neq':   $query->where($prop, '!=', $value); break;
                    case 'gt':    $query->where($prop, '>', $value);  break;
                    case 'gte':   $query->where($prop, '>=', $value); break;
                    case 'lt':    $query->where($prop, '<', $value);  break;
                    case 'lte':   $query->where($prop, '<=', $value); break;
                    case 'between':
                        $query->whereBetween($prop, [$value, $value2]);
                        break;
                    case 'not_between':
                        $query->whereNotBetween($prop, [$value, $value2]);
                        break;
                    case 'empty':
                        $isString = in_array($prop, ['name', 'sku', 'category'], true);
                        $query->where(function ($q) use ($prop, $isString) {
                            $q->whereNull($prop);
                            if ($isString) {
                                $q->orWhere($prop, '');
                            }
                        });
                        break;
                    case 'not_empty':
                        $isString = in_array($prop, ['name', 'sku', 'category'], true);
                        $query->where(function ($q) use ($prop, $isString) {
                            $q->whereNotNull($prop);
                            if ($isString) {
                                $q->where($prop, '!=', '');
                            }
                        });
                        break;
                }
            }
        }

        // --- Sorting ---------------------------------------------------------
        if (is_array($sort) && isset($sort['prop'], $sort['order'])
            && in_array($sort['prop'], self::ALLOWED_COLUMNS, true)) {
            $direction = in_array(strtolower($sort['order']), ['asc', 'desc'])
                ? strtolower($sort['order'])
                : 'asc';
            $query->orderBy($sort['prop'], $direction);
        } else {
            // Default: preserve insertion order
            $query->orderBy('sort_order');
        }

        // --- Pagination -------------------------------------------------------
        $total = $query->count();

        $data = $query
            ->skip(($page - 1) * $pageSize)
            ->take($pageSize)
            ->get();

        return response()->json(['data' => $data, 'total' => $total]);
    }

    // POST /api/products
    // Body: { position: 'above'|'below', referenceRowId, rowsAmount }
    public function store(Request $request): JsonResponse
    {
        $rowsAmount     = max(1, (int) $request->input('rowsAmount', 1));
        $position       = $request->input('position', 'below');
        $referenceRowId = $request->input('referenceRowId');

        $created = [];

        DB::transaction(function () use ($rowsAmount, $position, $referenceRowId, &$created) {
            $insertAt = $this->resolveInsertOrder($referenceRowId, $position, $rowsAmount);

            for ($i = 0; $i < $rowsAmount; $i++) {
                $created[] = Product::create([
                    'name'       => '',
                    'sku'        => 'NEW-' . strtoupper(bin2hex(random_bytes(3))),
                    'category'   => 'Electronics',
                    'price'      => 0,
                    'stock'      => 0,
                    'sort_order' => $insertAt + $i,
                ]);
            }
        });

        return response()->json($created, 201);
    }

    // PATCH /api/products
    // Body: [{ id, changes: { name?, price?, ... }, rowData? }, ...]
    public function batchUpdate(Request $request): JsonResponse
    {
        $rows = $request->json()->all();

        foreach ($rows as $row) {
            $product = Product::find($row['id'] ?? null);
            if ($product) {
                $changes = $row['changes'] ?? [];
                unset($changes['id'], $changes['sort_order']);
                $product->update($changes);
            }
        }

        return response()->json(null, 200);
    }

    // DELETE /api/products
    // Body: [1, 4, 7]
    public function batchDestroy(Request $request): JsonResponse
    {
        $ids = $request->json()->all();
        Product::whereIn('id', $ids)->delete();

        return response()->json(null, 204);
    }

    // Determines the sort_order for the new row(s) and shifts existing rows to make room.
    private function resolveInsertOrder(?int $referenceRowId, string $position, int $rowsAmount): int
    {
        if ($referenceRowId !== null) {
            $ref = Product::find($referenceRowId);
            if ($ref) {
                $insertAt = $position === 'above'
                    ? $ref->sort_order
                    : $ref->sort_order + 1;

                Product::where('sort_order', '>=', $insertAt)
                    ->increment('sort_order', $rowsAmount);

                return $insertAt;
            }
        }

        // No reference row — append after the current maximum
        return (int) (Product::max('sort_order') ?? 0) + 1;
    }

    // Escape LIKE metacharacters so literal % and _ in user input don't act as
    // wildcards. MySQL's default escape char is \, so we prefix \, %, and _ with \.
    private function escapeLike(string $value): string
    {
        return addcslashes($value, '\\%_');
    }
}
