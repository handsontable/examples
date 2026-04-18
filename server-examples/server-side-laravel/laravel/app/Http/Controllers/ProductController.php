<?php

namespace App\Http\Controllers;

use App\Models\Product;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class ProductController extends Controller
{
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

                $allowedColumns = ['name', 'sku', 'category', 'price', 'stock'];
                if (!$prop || !$condition || !in_array($prop, $allowedColumns, true)) {
                    continue;
                }

                switch ($condition) {
                    case 'contains':
                        $query->whereRaw("LOWER({$prop}) LIKE ?", ['%' . strtolower($value) . '%']);
                        break;
                    case 'not_contains':
                        $query->whereRaw("LOWER({$prop}) NOT LIKE ?", ['%' . strtolower($value) . '%']);
                        break;
                    case 'begins_with':
                        $query->whereRaw("LOWER({$prop}) LIKE ?", [strtolower($value) . '%']);
                        break;
                    case 'ends_with':
                        $query->whereRaw("LOWER({$prop}) LIKE ?", ['%' . strtolower($value)]);
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
                        $query->where(function ($q) use ($prop) {
                            $q->whereNull($prop)->orWhere($prop, '');
                        });
                        break;
                    case 'not_empty':
                        $query->where(function ($q) use ($prop) {
                            $q->whereNotNull($prop)->where($prop, '!=', '');
                        });
                        break;
                }
            }
        }

        // --- Sorting ---------------------------------------------------------
        if (is_array($sort) && isset($sort['prop'], $sort['order'])) {
            $allowedColumns = ['name', 'sku', 'category', 'price', 'stock'];
            $direction = in_array(strtolower($sort['order']), ['asc', 'desc'])
                ? strtolower($sort['order'])
                : 'asc';
            if (in_array($sort['prop'], $allowedColumns, true)) {
                $query->orderBy($sort['prop'], $direction);
            }
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
    // Body: { position, referenceRowId, rowsAmount }
    public function store(Request $request): JsonResponse
    {
        $rowsAmount = (int) $request->input('rowsAmount', 1);

        for ($i = 0; $i < $rowsAmount; $i++) {
            Product::create([
                'name'     => '',
                'sku'      => 'NEW-' . str_pad(Product::max('id') + 1, 3, '0', STR_PAD_LEFT),
                'category' => 'Electronics',
                'price'    => 0,
                'stock'    => 0,
            ]);
        }

        return response()->json(null, 201);
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
                unset($changes['id']);
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
}
