# Bash script that gets all filenames in assets/images/cats and writes them in the folliwng format:
# ["filename1", "filename2", ...]

# Get all filenames in assets/images/cats
filenames=$(ls assets/images/cats/)

# Write filenames in the desired format
echo "[" > catimg.json
for filename in $filenames
do
    echo "\"$filename\"," >> catimg.json
done
echo "]" >> catimg.json

# Done